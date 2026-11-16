import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pax } from '../src/samples.mjs';
import { collect, preview } from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

function header(name, size, type = '0') {
  const bytes = Buffer.alloc(512);
  bytes.write(name, 0, 100); bytes.write('0000644\0', 100); bytes.write('0001750\0', 108); bytes.write('0001750\0', 116);
  bytes.write(size.toString(8).padStart(11, '0') + '\0', 124); bytes.write('00000000001\0', 136);
  bytes.fill(32, 148, 156); bytes.write(type, 156); bytes.write('ustar\0', 257); bytes.write('00', 263);
  const checksum = bytes.reduce((sum, value) => sum + value, 0);
  bytes.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148); return bytes;
}
function member(name, bytes, type = '0', declaredSize = bytes.length) {
  return Buffer.concat([header(name, declaredSize, type), bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
function extension(records, type = 'x') {
  const body = Buffer.concat(records);
  return member(type === 'x' ? 'PaxHeader' : 'GlobalHeader', body, type);
}
function paddedMap(text) {
  const map = Buffer.alloc(Math.ceil(Buffer.byteLength(text) / 512) * 512);
  map.write(text, 0);
  return map;
}
function sparseMember(name, { map, payload, realsize, headerName = 'GNUSparseFile', declaredSize }) {
  const body = Buffer.concat([map, payload]);
  return member(headerName, body, '0', declaredSize === undefined ? body.length : declaredSize);
}
function sparseHeader(name, { realsize, map, extra = [] }) {
  return extension([
    pax('path', name), pax('GNU.sparse.major', '1'), pax('GNU.sparse.minor', '0'),
    pax('GNU.sparse.realsize', String(realsize)), pax('GNU.sparse.name', name), ...extra
  ]);
}
function archive(parts) { return Buffer.concat([...parts, Buffer.alloc(1024)]); }

async function run(bytes, check) {
  const store = new Inbox();
  try {
    const result = await collect({ name: 'test.tar', bytes, close: async () => {} }, store);
    await check(result, store);
  } finally { store.close(); }
}

test('existing physical preview still lists undecoded extension members', async () => {
  const bytes = archive([
    sparseHeader('站点/observations.bin', { realsize: 8192, map: Buffer.from('2\n0\n4\n4096\n4\n') }),
    sparseMember('GNUSparseFile', {
      map: Buffer.from('2\n0\n4\n4096\n4\n'), payload: Buffer.from('ABCDWXYZ'), realsize: 8192
    })
  ]);
  const store = new Inbox();
  try {
    const result = await preview({ name: 'test.tar', bytes }, store);
    assert.equal(result.mode, 'physical-member-preview');
    assert.deepEqual(result.members.map(row => [row.type, row.path]), [['x', 'PaxHeader'], ['0', 'GNUSparseFile']]);
  } finally { store.close(); }
});

test('leading, inter-extent and trailing holes are explicit logical ranges', async () => {
  const map = paddedMap('2\n100\n3\n400\n5\n');
  const payload = Buffer.from('abc12345');
  await run(archive([sparseHeader('holes.bin', { realsize: 500, map }), sparseMember('GNUSparseFile', { map, payload, realsize: 500 })]), async result => {
    assert.equal(result.status, 'complete');
    const record = result.records[0];
    assert.equal(record.logicalSize, 500);
    assert.equal(record.storedSize, 8);
    assert.deepEqual(record.holes, [{ offset: 0, length: 100 }, { offset: 103, length: 297 }, { offset: 405, length: 95 }]);
    assert.deepEqual(record.extents.map(row => [row.offset, row.length, row.sourceOffset]), [[100, 3, 1024 + 512 + 512], [400, 5, 1024 + 512 + 512 + 3]]);
    assert.deepEqual(record.layout.map(row => [row.kind, row.logicalOffset, row.length]), [
      ['hole', 0, 100], ['extent', 100, 3], ['hole', 103, 297], ['extent', 400, 5], ['hole', 405, 95]
    ]);
    const expected = createHash('sha256')
      .update(Buffer.alloc(100)).update(Buffer.from('abc')).update(Buffer.alloc(297))
      .update(Buffer.from('12345')).update(Buffer.alloc(95)).digest('hex');
    assert.equal(record.logicalSha256, expected);
    assert.notEqual(record.logicalSha256, record.physicalSha256);
    assert.notEqual(record.logicalSha256, result.packageSha256);
  });
});

test('PAX size overrides the ustar size and keeps the next member aligned', async () => {
  const x = extension([pax('path', '长名.bin'), pax('size', '5')]);
  const first = member('short', Buffer.from('HELLO'), '0', 3);
  const second = member('second.bin', Buffer.from('tail'));
  await run(archive([x, first, second]), async result => {
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.records.map(row => [row.path, row.logicalSize, row.storedSize]),
      [['长名.bin', 5, 5], ['second.bin', 4, 4]]);
    assert.equal(result.records[0].headerOffset, 1024);
    assert.equal(result.records[1].headerOffset, 1024 + 512 + 512);
  });
});

test('global PAX attributes are inherited and a local empty value deletes them', async () => {
  const g = extension([pax('path', 'global.bin'), pax('uid', '7')], 'g');
  const inherited = member('ignored.bin', Buffer.from('one'));
  const local = extension([pax('path', 'local.bin')]);
  const overridden = member('ignored-too.bin', Buffer.from('two'));
  const deleted = extension([pax('path', '')]);
  const fallback = member('header-name.bin', Buffer.from('three'));
  await run(archive([g, inherited, local, overridden, deleted, fallback]), async result => {
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.records.map(row => row.path),
      ['global.bin', 'local.bin', 'header-name.bin']);
    assert.equal(result.records[0].attributes.uid, '7');
    assert.equal(result.records[1].attributes.uid, '7');
    assert.equal(result.globalEvidence.length, 1);
  });
});

test('duplicate paths with different content stay separate occurrences in archive order', async () => {
  const one = member('same.bin', Buffer.from('alpha'));
  const two = member('same.bin', Buffer.from('bravo'));
  await run(archive([one, two]), async result => {
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.records.map(row => [row.order, row.path, row.logicalSize, row.headerOffset]),
      [[0, 'same.bin', 5, 0], [1, 'same.bin', 5, 1024]]);
    assert.notEqual(result.records[0].logicalSha256, result.records[1].logicalSha256);
    assert.notEqual(result.records[0].evidence.header, result.records[1].evidence.header);
  });
});

test('evidence keeps raw headers, maps and extent bytes in their archive positions', async () => {
  const map = paddedMap('1\n0\n4\n');
  const payload = Buffer.from('wxyz');
  await run(archive([sparseHeader('evidence.bin', { realsize: 8, map }), sparseMember('GNUSparseFile', { map, payload, realsize: 8 })]), async (result, store) => {
    const record = result.records[0];
    const saved = new Map(store.evidence().map(row => [row.id, row]));
    for (const id of [result.evidence, record.evidence.header, record.evidence.map,
      ...record.evidence.extendedHeaders, ...record.evidence.extents]) {
      assert.ok(saved.has(id), 'evidence ' + id + ' is missing from the Inbox');
    }
    assert.equal(saved.get(record.evidence.header).metadata.headerOffset, 1024);
    assert.equal(saved.get(record.evidence.map).metadata.size, 512);
    assert.equal(saved.get(record.evidence.extents[0]).metadata.sourceOffset, 2048);
    assert.equal(result.package.evidence, result.evidence);
    assert.equal(record.evidence.package, result.evidence);
  });
});

test('a long extent is received in bounded chunks rather than one giant buffer', async () => {
  const length = 300 * 1024;
  const body = Buffer.alloc(length, 0x5a);
  const map = paddedMap('1\n0\n' + length + '\n');
  await run(archive([sparseHeader('large.bin', { realsize: length, map }), sparseMember('GNUSparseFile', { map, payload: body, realsize: length })]), async result => {
    assert.equal(result.status, 'complete');
    const extent = result.records[0].extents[0];
    assert.equal(extent.length, length);
    assert.equal(extent.chunks.length, 2);
    for (const chunk of extent.chunks) assert.ok(chunk.length <= 256 * 1024);
    assert.equal(extent.chunks[1].logicalOffset, 256 * 1024);
  });
});

test('a huge logical hole is hashed without allocating it', async () => {
  const logicalSize = 128 * 1024 * 1024;
  const map = paddedMap('1\n0\n4\n');
  await run(archive([sparseHeader('mostly-hole.bin', { realsize: logicalSize, map }), sparseMember('GNUSparseFile', { map, payload: Buffer.from('data'), realsize: logicalSize })]), async result => {
    assert.equal(result.status, 'complete');
    const record = result.records[0];
    assert.equal(record.logicalSize, logicalSize);
    assert.equal(record.storedSize, 4);
    assert.deepEqual(record.holes, [{ offset: 4, length: logicalSize - 4 }]);
  });
});

test('a sparse member with no extents is one explicit hole', async () => {  const map = paddedMap('0\n');
  await run(archive([sparseHeader('empty.bin', { realsize: 4096, map }), sparseMember('GNUSparseFile', { map, payload: Buffer.alloc(0), realsize: 4096 })]), async result => {
    assert.equal(result.status, 'complete');
    const record = result.records[0];
    assert.equal(record.storedSize, 0);
    assert.deepEqual(record.extents, []);
    assert.deepEqual(record.holes, [{ offset: 0, length: 4096 }]);
    assert.equal(record.logicalSha256, createHash('sha256').update(Buffer.alloc(4096)).digest('hex'));
  });
});

test('a sparse map longer than one block is read to its padded end', async () => {
  const extents = [];
  for (let index = 0; index < 200; index += 1) extents.push(index * 2, 1);
  const map = paddedMap('200\n' + extents.join('\n') + '\n');
  assert.ok(map.length > 512);
  const payload = Buffer.alloc(200, 0x61);
  await run(archive([sparseHeader('many.bin', { realsize: 400, map }), sparseMember('GNUSparseFile', { map, payload, realsize: 400 })]), async result => {
    assert.equal(result.status, 'complete');
    const record = result.records[0];
    assert.equal(record.extents.length, 200);
    assert.equal(record.storedSize, 200);
    assert.equal(record.mapSize, map.length);
    assert.deepEqual(record.holes[0], { offset: 1, length: 1 });
    assert.deepEqual(record.holes[record.holes.length - 1], { offset: 399, length: 1 });
  });
});

for (const [label, build, reason] of [
  ['overlapping extents', () => {
    const map = paddedMap('2\n0\n4\n2\n4\n');
    return archive([sparseHeader('bad.bin', { realsize: 8192, map }), sparseMember('GNUSparseFile', { map, payload: Buffer.from('ABCDWXYZ'), realsize: 8192 })]);
  }, 'invalid-sparse-map'],
  ['negative extent values', () => {
    const map = paddedMap('2\n0\n4\n-2\n4\n');
    return archive([sparseHeader('bad.bin', { realsize: 8192, map }), sparseMember('GNUSparseFile', { map, payload: Buffer.from('ABCDWXYZ'), realsize: 8192 })]);
  }, 'invalid-sparse-map'],
  ['extent beyond logical size', () => {
    const map = paddedMap('1\n0\n10\n');
    return archive([sparseHeader('bad.bin', { realsize: 8, map }), sparseMember('GNUSparseFile', { map, payload: Buffer.alloc(10), realsize: 8 })]);
  }, 'invalid-sparse-map'],
  ['non-zero map padding', () => {
    const map = Buffer.alloc(512, 0x7f); map.write('1\n0\n4\n', 0);
    return archive([sparseHeader('bad.bin', { realsize: 8, map }), sparseMember('GNUSparseFile', { map, payload: Buffer.from('wxyz'), realsize: 8 })]);
  }, 'invalid-sparse-map'],
  ['absurd extent count', () => {
    const map = Buffer.alloc(512); map.write('999999999\n0\n4\n', 0);
    return archive([sparseHeader('bad.bin', { realsize: 8, map }), sparseMember('GNUSparseFile', { map, payload: Buffer.from('wxyz'), realsize: 8 })]);
  }, 'invalid-sparse-map'],
  ['payload shorter than its map', () => {
    const map = paddedMap('2\n0\n4\n4096\n4\n');
    return archive([sparseHeader('bad.bin', { realsize: 8192, map }), sparseMember('GNUSparseFile', { map, payload: Buffer.from('ABCD'), realsize: 8192 })]);
  }, 'truncated-sparse-payload'],
  ['payload longer than its map', () => {
    const map = paddedMap('1\n0\n4\n');
    return archive([sparseHeader('bad.bin', { realsize: 8192, map }), sparseMember('GNUSparseFile', { map, payload: Buffer.from('ABCDEFGH'), realsize: 8192 })]);
  }, 'invalid-sparse-payload'],
  ['unsupported sparse version', () => {
    const map = paddedMap('1\n0\n4\n');
    return archive([
      extension([pax('path', 'bad.bin'), pax('GNU.sparse.major', '0'), pax('GNU.sparse.minor', '1'),
        pax('GNU.sparse.realsize', '8192'), pax('GNU.sparse.name', 'bad.bin')]),
      sparseMember('GNUSparseFile', { map, payload: Buffer.from('wxyz'), realsize: 8192 })
    ]);
  }, 'unsupported-sparse-format'],
  ['malformed PAX record length', () => {
    const broken = Buffer.from('99 path=nope\n');
    return archive([member('PaxHeader', broken, 'x'), member('next.bin', Buffer.from('x'))]);
  }, 'invalid-pax'],
  ['corrupt header checksum', () => {
    const bytes = archive([member('one.bin', Buffer.from('one')), member('two.bin', Buffer.from('two'))]);
    bytes[0] ^= 1;
    return bytes;
  }, 'invalid-header']
]) {
  test(label + ' is reported as incomplete instead of being zero filled', async () => {
    await run(build(), async result => {
      assert.equal(result.status, 'incomplete');
      assert.equal(result.records.length, 0);
      assert.equal(result.pending[0].reason, reason);
      assert.ok(result.diagnostics.length > 0);
    });
  });
}

test('truncation reports which logical intervals did arrive', async () => {
  const map = paddedMap('2\n0\n4\n4096\n4\n');
  const full = archive([sparseHeader('cut.bin', { realsize: 8192, map }), sparseMember('GNUSparseFile', { map, payload: Buffer.from('ABCDWXYZ'), realsize: 8192 })]);
  // Extension member: 1024. Sparse header: 512. Map: 512. Payload: 8.
  // Cutting at 2055 leaves 7 of the 8 payload bytes, so the second extent
  // (source 2052, four bytes) is incomplete.
  const cut = full.subarray(0, 1024 + 512 + 512 + 7);
  await run(cut, async result => {
    assert.equal(result.status, 'incomplete');
    assert.equal(result.records.length, 0);
    const pending = result.pending[0];
    assert.equal(pending.reason, 'truncated-payload');
    assert.equal(pending.path, 'cut.bin');
    assert.deepEqual(pending.received.map(row => [row.logicalOffset, row.length, row.complete]),
      [[0, 4, true], [4096, 3, false]]);
    assert.deepEqual(pending.missing, { offset: 2052 + 3, length: 1 });
  });
});

test('records already closed before a later corrupt member survive with complete status data intact', async () => {
  const bytes = archive([member('good.bin', Buffer.from('good')), member('PaxHeader', Buffer.from('1 bad\n'), 'x')]);
  await run(bytes, async result => {
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.records.map(row => row.path), ['good.bin']);
    assert.equal(result.records[0].logicalSha256, createHash('sha256').update('good').digest('hex'));
  });
});

test('chunked delivery and whole-buffer delivery agree on logical and package digests', async () => {
  const map = paddedMap('2\n0\n4\n4096\n4\n');
  const bytes = archive([sparseHeader('站点/observations.bin', { realsize: 8192, map }), sparseMember('GNUSparseFile', { map, payload: Buffer.from('ABCDWXYZ'), realsize: 8192 })]);
  const chunked = { name: 'chunked.tar', close: async () => {}, async * chunks() { for (let offset = 0; offset < bytes.length; offset += 73) yield bytes.subarray(offset, offset + 73); } };
  const whole = { name: 'whole.tar', bytes, close: async () => {} };
  const firstStore = new Inbox(); const secondStore = new Inbox();
  try {
    const a = await collect(chunked, firstStore);
    const b = await collect(whole, secondStore);
    assert.equal(a.status, 'complete'); assert.equal(b.status, 'complete');
    assert.equal(a.packageSha256, b.packageSha256);
    assert.deepEqual(a.records.map(row => [row.logicalSha256, row.physicalSha256]),
      b.records.map(row => [row.logicalSha256, row.physicalSha256]));
  } finally { firstStore.close(); secondStore.close(); }
});

test('an archive without an end marker still closes its last member', async () => {
  await run(Buffer.concat([member('tail.bin', Buffer.from('tail'))]), async result => {
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.records.map(row => row.path), ['tail.bin']);
  });
});
