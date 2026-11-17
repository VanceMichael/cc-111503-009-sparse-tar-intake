import { createHash } from 'node:crypto';
import { tarHeader } from './tar-header.mjs';
import { paxAttributes, PaxError } from './pax.mjs';
import { sparseMap } from './sparse.mjs';
import { digest } from './store.mjs';

// Logical holes are hashed through one fixed-size zero block, so confirming a
// multi-GiB sparse delivery never allocates a logical-size buffer.
const ZERO_CHUNK = Buffer.alloc(1024 * 1024);

function hashZeros(hash, length) {
  let remaining = length;
  while (remaining > 0) {
    const step = Math.min(remaining, ZERO_CHUNK.length);
    hash.update(ZERO_CHUNK.subarray(0, step));
    remaining -= step;
  }
}

async function packageBytes(source) {
  if (source.bytes) return source.bytes;
  const parts = [];
  for await (const chunk of source.chunks()) parts.push(chunk);
  return Buffer.concat(parts);
}

function holeList(extents, logicalSize) {
  const holes = [];
  let cursor = 0;
  for (const { offset, length } of extents) {
    if (offset > cursor) holes.push({ offset: cursor, length: offset - cursor });
    cursor = offset + length;
  }
  if (logicalSize > cursor) holes.push({ offset: cursor, length: logicalSize - cursor });
  return holes;
}

export async function collect(source, store) {
  const bytes = await packageBytes(source);
  // Physical package digest: identifies the transported archive as received.
  const packageEvidence = store.saveEvidence('tar-package', { name: source.name }, bytes);
  const records = [];
  const pending = [];
  const diagnostics = [];
  const globals = {};
  const globalEvidence = [];
  let nextAttributes = null;
  let nextEvidence = null;
  let sequence = 0;
  let offset = 0;
  let closed = false;

  const diagnose = (code, message, detail = {}) => {
    diagnostics.push({ code, message, ...detail });
  };

  while (offset + 512 <= bytes.length) {
    let header;
    try {
      header = tarHeader(bytes.subarray(offset, offset + 512));
    } catch (error) {
      diagnose('bad-header', error.message, { headerOffset: offset });
      break;
    }
    if (header.end) { closed = true; break; }
    const headerOffset = offset;
    const dataOffset = offset + 512;

    if (header.type === 'x' || header.type === 'g') {
      if (dataOffset + header.size > bytes.length) {
        diagnose('truncated', `PAX ${header.type} block is truncated`, { headerOffset });
        break;
      }
      const raw = bytes.subarray(dataOffset, dataOffset + header.size);
      let attributes;
      try {
        attributes = paxAttributes(raw);
      } catch (error) {
        if (!(error instanceof PaxError)) throw error;
        diagnose('bad-pax', error.message, { headerOffset });
        break;
      }
      const evidence = store.saveEvidence(
        header.type === 'x' ? 'pax-extended-header' : 'pax-global-header', { headerOffset }, raw);
      if (header.type === 'x') {
        nextAttributes = { ...nextAttributes, ...attributes };
        nextEvidence = evidence;
      } else {
        Object.assign(globals, attributes);
        globalEvidence.push(evidence);
      }
      offset = dataOffset + Math.ceil(header.size / 512) * 512;
      continue;
    }

    if (header.type !== '0') {
      diagnose('unsupported-type', `member type '${header.type}' is not a deliverable file`, { headerOffset });
      pending.push({ sequence, path: header.path, headerOffset, reason: 'unsupported-type', type: header.type });
      sequence += 1;
      offset = dataOffset + Math.ceil(header.size / 512) * 512;
      continue;
    }

    // x attributes apply to this member only; g attributes persist across members.
    const attributes = { ...globals, ...nextAttributes };
    const paxEvidence = nextEvidence;
    nextAttributes = null;
    nextEvidence = null;

    let physicalSize = header.size;
    if (attributes.size !== undefined) {
      physicalSize = Number(attributes.size);
      if (!Number.isSafeInteger(physicalSize) || physicalSize < 0) {
        diagnose('bad-pax-size', `PAX size '${attributes.size}' is not a usable byte count`, { headerOffset });
        pending.push({ sequence, path: attributes.path ?? header.path, headerOffset, reason: 'bad-pax-size' });
        break;
      }
    }
    const path = attributes['GNU.sparse.name'] ?? attributes.path ?? header.path;
    const headerEvidence = store.saveEvidence(
      'tar-member-header', { path, headerOffset, sequence }, bytes.subarray(headerOffset, headerOffset + 512));

    if (dataOffset + physicalSize > bytes.length) {
      const receivedBytes = Math.max(0, bytes.length - dataOffset);
      diagnose('truncated', `member data truncated: ${receivedBytes} of ${physicalSize} bytes arrived`, { headerOffset, path });
      pending.push({ sequence, path, headerOffset, reason: 'truncated', expectedBytes: physicalSize, receivedBytes });
      break;
    }
    const data = bytes.subarray(dataOffset, dataOffset + physicalSize);
    const sparse = attributes['GNU.sparse.major'] !== undefined || attributes['GNU.sparse.realsize'] !== undefined;

    if (!sparse) {
      records.push({
        sequence, path, type: 'regular', headerOffset, dataOffset,
        logicalSize: physicalSize, storedSize: data.length,
        extents: physicalSize === 0 ? [] : [{ offset: 0, length: physicalSize, sourceOffset: dataOffset }],
        holes: [],
        logicalSha256: digest(data),
        payload: store.saveEvidence('member-payload', { path }, data),
        headerEvidence, paxEvidence, attributes,
      });
    } else {
      const major = attributes['GNU.sparse.major'];
      const minor = attributes['GNU.sparse.minor'] ?? '0';
      const logicalSize = Number(attributes['GNU.sparse.realsize']);
      let problem = null;
      let parsed = null;
      if (major !== '1' || minor !== '0') {
        problem = `unsupported GNU.sparse version ${major}.${minor}`;
      } else if (!Number.isSafeInteger(logicalSize) || logicalSize < 0) {
        problem = `GNU.sparse.realsize '${attributes['GNU.sparse.realsize']}' is not a usable byte count`;
      } else {
        try {
          parsed = sparseMap(data, logicalSize);
        } catch (error) {
          problem = error.message;
        }
      }
      if (problem) {
        diagnose('invalid-sparse-map', problem, { headerOffset, path });
        pending.push({ sequence, path, headerOffset, reason: 'invalid-sparse-map', detail: problem });
      } else {
        // Logical digest: extent bytes plus zero hashed holes, streamed.
        const hash = createHash('sha256');
        let cursor = 0;
        let payloadCursor = 0;
        const extents = parsed.extents.map(({ offset: logicalOffset, length }) => {
          hashZeros(hash, logicalOffset - cursor);
          hash.update(parsed.payload.subarray(payloadCursor, payloadCursor + length));
          const extent = { offset: logicalOffset, length, sourceOffset: dataOffset + parsed.mapPadded + payloadCursor };
          payloadCursor += length;
          cursor = logicalOffset + length;
          return extent;
        });
        hashZeros(hash, logicalSize - cursor);
        records.push({
          sequence, path, type: 'sparse', headerOffset, dataOffset,
          logicalSize, storedSize: parsed.payload.length,
          extents,
          holes: holeList(extents, logicalSize),
          logicalSha256: hash.digest('hex'),
          payload: store.saveEvidence('sparse-payload', { path }, parsed.payload),
          headerEvidence, paxEvidence, attributes,
        });
      }
    }
    sequence += 1;
    offset = dataOffset + Math.ceil(physicalSize / 512) * 512;
  }

  if (!closed && diagnostics.length === 0) {
    if (offset === bytes.length) diagnose('missing-end-marker', 'archive ended without the zero-block end marker');
    else diagnose('truncated', 'archive ends with a partial header', { headerOffset: offset });
  }

  const status = closed && diagnostics.length === 0 && pending.length === 0 ? 'complete' : 'incomplete';
  for (const record of records) {
    store.put('deliveries', `${packageEvidence}:${String(record.sequence).padStart(6, '0')}`, record);
  }
  return {
    mode: 'pax-sparse-collect',
    status,
    package: {
      evidence: packageEvidence,
      sha256: digest(bytes),
      size: bytes.length,
      closed,
      globalEvidence,
    },
    records,
    pending,
    diagnostics,
  };
}
