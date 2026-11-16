import { createHash } from 'node:crypto';
import { tarHeader } from './tar-header.mjs';
import { parsePaxRecords, paxNumber } from './pax.mjs';

// Reading is streaming and bounded. Headers, PAX records and sparse maps are
// the only structures held whole; member payload is read in fixed-size chunks,
// hashed and stored chunk by chunk. The logical size of a sparse member is
// therefore never materialised as one buffer, and holes are folded into the
// logical digest a bounded block at a time.
export class ShortRead extends Error {
  constructor(expected, available) {
    super('archive ended after ' + available + ' of ' + expected + ' expected bytes');
    this.code = 'truncated';
    this.expected = expected;
    this.available = available;
  }
}

export class ByteReader {
  constructor(source) {
    this.source = source;
    this.iterator = null;
    this.chunks = [];
    this.available = 0;
    this.consumed = 0;
    this.fetched = 0;
    this.done = false;
    this.hash = createHash('sha256');
  }

  sourceChunks() {
    if (this.source && typeof this.source.chunks === 'function') return this.source.chunks();
    const bytes = this.source && this.source.bytes;
    if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
      return (async function* () { yield bytes; })();
    }
    throw new Error('source must expose bytes or chunks()');
  }

  async pull() {
    if (this.done) return null;
    if (!this.iterator) this.iterator = this.sourceChunks()[Symbol.asyncIterator]();
    while (true) {
      const { value, done } = await this.iterator.next();
      if (done) { this.done = true; return null; }
      if (value === null || value === undefined) continue;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.length === 0) continue;
      this.fetched += chunk.length;
      // The physical package digest covers every byte the source delivered,
      // including padding and anything after the end-of-archive marker.
      this.hash.update(chunk);
      return chunk;
    }
  }

  async fill(count) {
    while (this.available < count && !this.done) {
      const chunk = await this.pull();
      if (!chunk) break;
      this.chunks.push(chunk);
      this.available += chunk.length;
    }
    return this.available;
  }

  // Copies only what was asked for; queued source chunks are sliced in place
  // so a large source chunk does not get copied once per read.
  take(count) {
    if (count === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first.length === count) {
      this.chunks.shift();
      this.available -= count;
      return first;
    }
    if (first.length > count) {
      this.chunks[0] = first.subarray(count);
      this.available -= count;
      return first.subarray(0, count);
    }
    const result = Buffer.allocUnsafe(count);
    let written = 0;
    while (written < count) {
      const head = this.chunks[0];
      const take = Math.min(head.length, count - written);
      head.copy(result, written, 0, take);
      written += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      this.available -= take;
    }
    return result;
  }

  async readExact(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('invalid read length');
    const available = await this.fill(count);
    if (available < count) throw new ShortRead(count, available);
    const result = this.take(count);
    this.consumed += count;
    return result;
  }

  async skip(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('invalid skip length');
    let remaining = count;
    while (remaining > 0) {
      if (this.chunks.length === 0 && !this.done) {
        const chunk = await this.pull();
        if (!chunk) throw new ShortRead(remaining, 0);
        this.chunks.push(chunk);
        this.available += chunk.length;
      }
      const head = this.chunks[0];
      const take = Math.min(remaining, head.length);
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      this.available -= take;
      this.consumed += take;
      remaining -= take;
    }
  }

  async drain() {
    this.chunks = [];
    this.available = 0;
    while (await this.pull()) { /* every pulled byte already entered the package hash */ }
  }

  digest() { return this.hash.digest('hex'); }
}

class ArchiveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function applyPax(base, records) {
  const next = new Map(base);
  for (const record of records) {
    // POSIX: an empty value in a PAX record deletes the inherited key. This is
    // how a local x header removes something a g header installed earlier.
    if (record.value === '') next.delete(record.key);
    else next.set(record.key, record.value);
  }
  return next;
}

function paddingFor(size) { return (512 - (size % 512)) % 512; }

function updateZeros(hash, count, zero) {
  let remaining = count;
  while (remaining > 0) {
    const take = Math.min(remaining, zero.length);
    hash.update(take === zero.length ? zero : zero.subarray(0, take));
    remaining -= take;
  }
}

function parseDecimalLine(line) {
  const text = line.toString('latin1');
  if (!/^[0-9]+$/.test(text)) {
    throw new ArchiveError('invalid-sparse-map', 'sparse map line is not a non-negative decimal integer');
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new ArchiveError('invalid-sparse-map', 'sparse map value is out of range');
  return value;
}

const MAX_MAP_EXTENTS = 1 << 18;

// GNU sparse 1.0 map: a count line then offset/length pairs, every line
// decimal and LF terminated, the whole map padded to 512 bytes. It is parsed
// incrementally so a multi-block map costs one small block per step.
async function readSparseMap(reader, physicalSize, logicalSize, memberHash) {
  const extents = [];
  const rawBlocks = [];
  let count = null;
  let extentIndex = 0;
  let pendingOffset = null;
  let previousEnd = 0;
  let carry = Buffer.alloc(0);
  let mapBytesRead = 0;
  let lineBytes = 0;
  let mapSize = null;

  const pushValue = value => {
    if (count === null) {
      count = value;
      if (count > Math.floor(physicalSize / 4) + 1 || count > MAX_MAP_EXTENTS) {
        throw new ArchiveError('invalid-sparse-map', 'sparse extent count cannot fit inside the member data');
      }
      return;
    }
    if (pendingOffset === null) { pendingOffset = value; return; }
    const offset = pendingOffset;
    const length = value;
    pendingOffset = null;
    extentIndex += 1;
    if (offset < previousEnd) {
      throw new ArchiveError('invalid-sparse-map', 'sparse extents overlap or are not in increasing order');
    }
    if (!Number.isSafeInteger(offset + length) || offset + length > logicalSize) {
      throw new ArchiveError('invalid-sparse-map', 'sparse extent exceeds the logical member size');
    }
    extents.push({ offset, length });
    previousEnd = offset + length;
  };

  while (mapSize === null) {
    if (mapBytesRead >= physicalSize) {
      throw new ArchiveError('invalid-sparse-map', 'sparse map is incomplete inside the physical member data');
    }
    const block = await reader.readExact(Math.min(512, physicalSize - mapBytesRead));
    memberHash.update(block);
    rawBlocks.push(Buffer.from(block));
    mapBytesRead += block.length;
    carry = carry.length === 0 ? Buffer.from(block) : Buffer.concat([carry, block]);
    let newline;
    while ((newline = carry.indexOf(0x0a)) >= 0) {
      const line = carry.subarray(0, newline);
      if (line.length > 20) throw new ArchiveError('invalid-sparse-map', 'sparse map line is unreasonably long');
      pushValue(parseDecimalLine(line));
      lineBytes += line.length + 1;
      carry = carry.subarray(newline + 1);
      if (count !== null && pendingOffset === null && extentIndex === count) {
        mapSize = Math.ceil(lineBytes / 512) * 512;
        break;
      }
    }
    if (mapSize === null && carry.length > 20) {
      throw new ArchiveError('invalid-sparse-map', 'sparse map line is unreasonably long');
    }
  }

  if (mapSize > physicalSize) throw new ArchiveError('invalid-sparse-map', 'sparse map does not fit inside the physical member data');
  // From the end of the last map line up to the 512 byte boundary everything
  // must be NUL. Non-zero bytes there mean the map was read wrongly, and that
  // has to surface as corruption rather than be silently skipped.
  while (mapBytesRead < mapSize) {
    const block = await reader.readExact(mapSize - mapBytesRead);
    memberHash.update(block);
    rawBlocks.push(Buffer.from(block));
    mapBytesRead += block.length;
    carry = carry.length === 0 ? block : Buffer.concat([carry, block]);
  }
  for (let index = 0; index < carry.length; index += 1) {
    if (carry[index] !== 0) throw new ArchiveError('invalid-sparse-map', 'sparse map padding contains unexpected non-zero bytes');
  }
  return { mapSize, extents, mapBytes: Buffer.concat(rawBlocks) };
}

function pathFrom(attributes, header, sparse) {
  if (sparse && attributes.has('GNU.sparse.name')) return attributes.get('GNU.sparse.name');
  if (attributes.has('path')) return attributes.get('path');
  return header.path;
}

function sumExtents(extents) {
  let total = 0;
  for (const extent of extents) {
    if (!Number.isSafeInteger(total + extent.length)) {
      throw new ArchiveError('invalid-sparse-map', 'sparse payload length is out of range');
    }
    total += extent.length;
  }
  return total;
}

const CHUNK = 256 * 1024;
const ZERO_BLOCK = Buffer.alloc(1024 * 1024);

// Reads one logical extent in bounded chunks. Nothing larger than CHUNK is
// ever allocated, so a long run of useful bytes does not become one huge
// buffer. Each chunk is saved as evidence keyed by its logical interval. If the
// package ends mid-chunk, the bytes that did arrive are still recorded, marked
// as partial, before the short read is reported.
async function readExtent(reader, extent, context, memberHash, logicalHash, store) {
  const extentHash = createHash('sha256');
  const chunks = [];
  const evidence = [];
  const chunkCount = Math.ceil(extent.length / CHUNK);
  let consumed = 0;

  const saveChunk = (piece, complete) => {
    const logicalOffset = extent.offset + consumed;
    const sourceOffset = context.sourceOffset + consumed;
    const chunkSha256 = createHash('sha256').update(piece).digest('hex');
    const id = store.saveEvidence('extent-content', {
      name: context.name,
      headerOffset: context.headerOffset,
      path: context.path,
      logicalOffset,
      length: piece.length,
      sourceOffset,
      chunk: chunks.length,
      chunkCount,
      complete
    }, piece);
    const chunk = { logicalOffset, length: piece.length, sourceOffset, sha256: chunkSha256, evidence: id, complete };
    chunks.push(chunk);
    evidence.push(id);
    // Reported even if a later extent is truncated, so a receiver can tell
    // which logical intervals really arrived from the damaged package.
    context.onChunk(chunk);
    consumed += piece.length;
  };

  while (consumed < extent.length) {
    const take = Math.min(CHUNK, extent.length - consumed);
    let piece;
    try {
      piece = await reader.readExact(take);
    } catch (error) {
      if (error instanceof ShortRead && reader.available > 0) {
        saveChunk(reader.take(reader.available), false);
      }
      throw error;
    }
    memberHash.update(piece);
    logicalHash.update(piece);
    extentHash.update(piece);
    saveChunk(piece, true);
  }
  return { sha256: extentHash.digest('hex'), chunks, evidence };
}

export async function collect(source, store) {
  const reader = new ByteReader(source);
  const records = [];
  const pending = [];
  const diagnostics = [];
  const globalEvidence = [];
  let globalAttributes = new Map();
  let localRecords = [];
  let localEvidence = [];
  let archiveOrder = 0;

  try {
    while (true) {
      const headerOffset = reader.consumed;
      let headerBytes;
      try {
        headerBytes = await reader.readExact(512);
      } catch (error) {
        if (error instanceof ShortRead && error.available === 0) break;
        if (error instanceof ShortRead) throw new ArchiveError('truncated-header', 'archive ended in the middle of a tar header', { headerOffset });
        throw error;
      }
      let header;
      try {
        header = tarHeader(headerBytes);
      } catch (error) {
        store.saveEvidence('tar-header', { name: source && source.name, headerOffset, corrupt: true }, headerBytes);
        throw new ArchiveError('invalid-header', 'tar header is invalid: ' + error.message, { headerOffset });
      }
      if (header.end) {
        if (localEvidence.length) throw new ArchiveError('orphan-pax-header', 'PAX extended header has no following member', { headerOffset });
        break;
      }

      const headerEvidence = store.saveEvidence('tar-header', {
        name: source && source.name, headerOffset, type: header.type, path: header.path,
        size: header.size, headerSha256: createHash('sha256').update(headerBytes).digest('hex')
      }, headerBytes);

      if (header.type === 'x' || header.type === 'g') {
        let data;
        try {
          // PAX record bodies are small metadata; refusing an implausible size
          // stops a corrupt header from forcing a giant allocation.
          if (header.size > 64 * 1024 * 1024) {
            throw new ArchiveError('invalid-pax', 'PAX extended header is implausibly large', { headerOffset });
          }
          data = await reader.readExact(header.size);
          await reader.skip(paddingFor(header.size));
        } catch (error) {
          if (error instanceof ShortRead) throw new ArchiveError('truncated-pax', 'PAX extended header is truncated', { headerOffset });
          throw error;
        }
        const recordsBytes = Buffer.from(data);
        const recordsEvidence = store.saveEvidence('pax-records', {
          name: source && source.name, headerOffset, dataOffset: headerOffset + 512, scope: header.type, size: header.size
        }, recordsBytes);
        let parsed;
        try {
          parsed = parsePaxRecords(recordsBytes);
        } catch (error) {
          throw new ArchiveError('invalid-pax', 'PAX records are invalid: ' + error.message, { headerOffset });
        }
        if (header.type === 'g') {
          globalAttributes = applyPax(globalAttributes, parsed);
          globalEvidence.push(recordsEvidence);
        } else {
          // Local records stay ordered: a later record wins, and an empty
          // value deletes an attribute inherited from a global header.
          localRecords = localRecords.concat(parsed);
          localEvidence.push(recordsEvidence);
        }
        continue;
      }

      // This header belongs to a real member; its local PAX records are used
      // exactly once, even if the member later proves invalid.
      const attributes = applyPax(globalAttributes, localRecords);
      const sparse = [...attributes.keys()].some(key => key.startsWith('GNU.sparse.'));
      const logicalName = pathFrom(attributes, header, sparse);

      if (header.type !== '0') {
        // Hard links, directories and devices are outside the delivery
        // contract: consume their physical bytes, publish nothing.
        try {
          await reader.skip(header.size);
          await reader.skip(paddingFor(header.size));
        } catch (error) {
          if (error instanceof ShortRead) throw new ArchiveError('truncated-member', 'non-regular member is truncated', { headerOffset, path: logicalName });
          throw error;
        }
        localRecords = []; localEvidence = [];
        continue;
      }

      let physicalSize = header.size;
      if (attributes.has('size')) {
        try {
          physicalSize = paxNumber(attributes.get('size'), 'size');
        } catch (error) {
          throw new ArchiveError('invalid-size', error.message, { headerOffset, path: logicalName });
        }
      }

      let logicalSize = physicalSize;
      if (sparse) {
        const major = attributes.has('GNU.sparse.major') ? attributes.get('GNU.sparse.major') : null;
        const minor = attributes.has('GNU.sparse.minor') ? attributes.get('GNU.sparse.minor') : null;
        if (major !== '1' || minor !== '0') {
          throw new ArchiveError('unsupported-sparse-format', 'only GNU sparse 1.0 is supported', { headerOffset, path: logicalName });
        }
        if (!attributes.has('GNU.sparse.realsize')) {
          throw new ArchiveError('invalid-sparse-map', 'sparse member has no GNU.sparse.realsize', { headerOffset, path: logicalName });
        }
        try {
          logicalSize = paxNumber(attributes.get('GNU.sparse.realsize'), 'GNU.sparse.realsize');
        } catch (error) {
          throw new ArchiveError('invalid-size', error.message, { headerOffset, path: logicalName });
        }
      }

      const memberHash = createHash('sha256');
      const logicalHash = createHash('sha256');
      const record = {
        order: archiveOrder,
        path: logicalName,
        headerOffset,
        dataOffset: headerOffset + 512,
        type: header.type,
        sparse,
        physicalSize,
        mapSize: 0,
        storedSize: 0,
        logicalSize,
        extents: [],
        holes: [],
        layout: [],
        logicalSha256: null,
        physicalSha256: null,
        headerSha256: createHash('sha256').update(headerBytes).digest('hex'),
        attributes: Object.fromEntries(attributes),
        evidence: {
          package: null,
          header: headerEvidence,
          extendedHeaders: [...localEvidence],
          map: null,
          extents: []
        }
      };

      let mapSize = 0;
      let extents;
      if (sparse) {
        let parsed;
        try {
          // A zero-length physical body cannot carry a map, which describes a
          // member whose logical content is entirely hole.
          parsed = physicalSize === 0
            ? { mapSize: 0, extents: [], mapBytes: Buffer.alloc(0) }
            : await readSparseMap(reader, physicalSize, logicalSize, memberHash);
        } catch (error) {
          if (error instanceof ShortRead) throw new ArchiveError('truncated-sparse-map', 'sparse map is truncated', { headerOffset, path: logicalName });
          throw error;
        }
        mapSize = parsed.mapSize;
        extents = parsed.extents;
        record.mapSize = mapSize;
        record.evidence.map = mapSize > 0 ? store.saveEvidence('sparse-map', {
          name: source && source.name, headerOffset, path: logicalName,
          offset: record.dataOffset, size: mapSize, logicalSize,
          mapSha256: createHash('sha256').update(parsed.mapBytes).digest('hex')
        }, parsed.mapBytes) : null;
        const payloadLength = physicalSize - mapSize;
        const expected = sumExtents(extents);
        if (payloadLength < expected) {
          throw new ArchiveError('truncated-sparse-payload',
            'sparse payload has ' + payloadLength + ' of ' + expected + ' extent bytes',
            { headerOffset, path: logicalName });
        }
        if (payloadLength > expected) {
          throw new ArchiveError('invalid-sparse-payload',
            'sparse payload has ' + payloadLength + ' bytes but extents account for ' + expected,
            { headerOffset, path: logicalName });
        }
      } else {
        extents = physicalSize > 0 ? [{ offset: 0, length: physicalSize }] : [];
      }

      let cursor = 0;
      let sourceOffset = record.dataOffset + mapSize;
      // Chunks already physically read, in logical order. Kept separately from
      // `record` so even a failed member can report what actually arrived.
      const received = [];
      try {
        for (const extent of extents) {
          if (extent.offset > cursor) {
            updateZeros(logicalHash, extent.offset - cursor, ZERO_BLOCK);
            const hole = { offset: cursor, length: extent.offset - cursor };
            record.holes.push(hole);
            record.layout.push({ kind: 'hole', logicalOffset: hole.offset, length: hole.length });
          }
          const content = await readExtent(reader, extent, {
            name: source && source.name, headerOffset, path: logicalName, sourceOffset,
            onChunk: chunk => received.push(chunk)
          }, memberHash, logicalHash, store);
          const entry = {
            offset: extent.offset,
            length: extent.length,
            sourceOffset,
            sourceLength: extent.length,
            sourceRange: { offset: sourceOffset, length: extent.length },
            sha256: content.sha256,
            chunks: content.chunks,
            evidence: content.evidence
          };
          record.extents.push(entry);
          record.evidence.extents.push(...content.evidence);
          record.layout.push({
            kind: 'extent', logicalOffset: extent.offset, length: extent.length,
            sourceOffset, sourceLength: extent.length, sha256: content.sha256
          });
          sourceOffset += extent.length;
          record.storedSize += extent.length;
          cursor = extent.offset + extent.length;
        }
        if (cursor < logicalSize) {
          updateZeros(logicalHash, logicalSize - cursor, ZERO_BLOCK);
          const hole = { offset: cursor, length: logicalSize - cursor };
          record.holes.push(hole);
          record.layout.push({ kind: 'hole', logicalOffset: hole.offset, length: hole.length });
        }
        const pad = paddingFor(physicalSize);
        if (pad > 0) await reader.skip(pad);
      } catch (error) {
        if (error instanceof ShortRead) {
          const missingOffset = received.reduce(
            (offset, chunk) => Math.max(offset, chunk.sourceOffset + chunk.length), sourceOffset);
          throw new ArchiveError('truncated-payload', 'member payload is truncated', {
            headerOffset, path: logicalName, received,
            missing: { offset: missingOffset, length: error.expected - error.available }
          });
        }
        throw error;
      }

      record.logicalSha256 = logicalHash.digest('hex');
      record.physicalSha256 = memberHash.digest('hex');
      records.push(record);
      archiveOrder += 1;
      localRecords = []; localEvidence = [];
    }
  } catch (error) {
    if (error instanceof ArchiveError) {
      diagnostics.push(error.message);
      pending.push({ ...error.details, reason: error.code });
    } else if (error instanceof ShortRead) {
      diagnostics.push(error.message);
      pending.push({ headerOffset: reader.consumed, path: null, reason: 'truncated' });
    } else {
      // A non-archive failure (for example the source itself throwing) is not
      // something to publish as a partially received delivery.
      throw error;
    }
  } finally {
    try {
      await reader.drain();
    } catch (error) {
      diagnostics.push('could not finish reading the physical package: ' + (error && error.message ? error.message : error));
    }
  }

  // Physical package identity (bytes as delivered) is distinct from each
  // member's logical digest; neither ever stands in for the other.
  const packageSha256 = reader.digest();
  const packageSize = reader.fetched;
  let packageEvidence;
  if (source && Buffer.isBuffer(source.bytes)) {
    packageEvidence = store.saveEvidence('tar-package', {
      name: source.name, sha256: packageSha256, size: packageSize
    }, source.bytes);
  } else {
    packageEvidence = store.saveEvidence('tar-package-digest', {
      name: source && source.name, sha256: packageSha256, size: packageSize
    }, Buffer.alloc(0));
  }
  for (const record of records) record.evidence.package = packageEvidence;

  return {
    status: diagnostics.length === 0 ? 'complete' : 'incomplete',
    mode: 'logical-sparse-collection',
    packageSha256,
    packageSize,
    package: { sha256: packageSha256, size: packageSize, evidence: packageEvidence },
    evidence: packageEvidence,
    globalEvidence,
    records,
    pending,
    diagnostics
  };
}
