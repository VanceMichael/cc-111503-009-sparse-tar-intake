import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, pax, header, member } from '../src/samples.mjs';
import { collect } from '../src/intake.mjs';
import { Inbox, digest } from '../src/store.mjs';

async function run(source, check) {
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    await check(result, store);
  } finally { store.close(); await source.close(); }
}

function archiveOf(...parts) {
  return { name: 'custom.tar', bytes: Buffer.concat([...parts, Buffer.alloc(1024)]),
    close: async () => {} };
}

test('holes are explicit and extents carry their physical source ranges', async () => {
  const source = await fixture();
  await run(source, async (result, store) => {
    const [record] = result.records;
    assert.deepEqual(record.holes, [{ offset: 4, length: 4092 }, { offset: 4100, length: 4092 }]);
    assert.deepEqual(record.extents, [
      { offset: 0, length: 4, sourceOffset: 2048 },
      { offset: 4096, length: 4, sourceOffset: 2052 },
    ]);
    assert.equal(record.sequence, 0);
    assert.equal(record.type, 'sparse');
    const kinds = store.evidence().map(row => row.kind).sort();
    assert.deepEqual(kinds, ['pax-extended-header', 'sparse-payload', 'tar-member-header', 'tar-package']);
    assert.equal(store.list('deliveries').length, 1);
  });
});

test('logical digest and physical package digest stay separate concerns', async () => {
  const source = await fixture();
  await run(source, async (result, store) => {
    assert.equal(result.package.sha256, digest(source.bytes));
    assert.notEqual(result.records[0].logicalSha256, result.package.sha256);
    assert.notEqual(result.records[0].payload, result.package.evidence);
    const ids = store.evidence().map(row => row.id);
    assert.ok(ids.includes(result.package.evidence));
    assert.ok(ids.includes(result.records[0].payload));
    assert.ok(ids.includes(result.records[0].headerEvidence));
  });
});

test('g attributes persist across members while x overrides the next member only', async () => {
  const source = archiveOf(
    member('PaxGlobal', pax('comment', 'station-wide'), 'g'),
    member('PaxHeader', Buffer.concat([pax('path', 'a.bin'), pax('comment', 'next-only')]), 'x'),
    member('header-name.bin', Buffer.from('AAAA')),
    member('b.bin', Buffer.from('BBBB')),
  );
  await run(source, async result => {
    assert.equal(result.status, 'complete');
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0].path, 'a.bin');
    assert.equal(result.records[0].attributes.comment, 'next-only');
    assert.equal(result.records[1].path, 'b.bin');
    assert.equal(result.records[1].attributes.comment, 'station-wide');
  });
});

test('a huge sparse member is confirmed without a logical-size buffer', async () => {
  const logicalSize = 2 ** 33;
  const name = 'huge.bin';
  const attributes = Buffer.concat([
    pax('path', name), pax('GNU.sparse.major', '1'), pax('GNU.sparse.minor', '0'),
    pax('GNU.sparse.realsize', String(logicalSize)), pax('GNU.sparse.name', name)]);
  const map = Buffer.alloc(512);
  map.write(`2\n0\n4\n${logicalSize - 4}\n4\n`);
  const source = archiveOf(
    member('PaxHeader', attributes, 'x'),
    member('GNUSparseFile', Buffer.concat([map, Buffer.from('ABCDWXYZ')])),
  );
  const zero = Buffer.alloc(1024 * 1024);
  const hash = createHash('sha256');
  const fill = length => { let rest = length; while (rest > 0) { const n = Math.min(rest, zero.length); hash.update(zero.subarray(0, n)); rest -= n; } };
  hash.update(Buffer.from('ABCD')); fill(logicalSize - 8); hash.update(Buffer.from('WXYZ'));
  await run(source, async result => {
    assert.equal(result.status, 'complete');
    const [record] = result.records;
    assert.equal(record.logicalSize, logicalSize);
    assert.equal(record.storedSize, 8);
    assert.deepEqual(record.holes, [{ offset: 4, length: logicalSize - 8 }]);
    assert.equal(record.logicalSha256, hash.digest('hex'));
  });
});

test('corrupt mappings land in pending with diagnostics, never in records', async () => {
  for (const [scenario, reason] of [['overlap', 'invalid-sparse-map'], ['truncated', 'truncated']]) {
    const source = await fixture(scenario);
    await run(source, async result => {
      assert.equal(result.status, 'incomplete');
      assert.equal(result.records.length, 0);
      assert.equal(result.pending.length, 1);
      assert.equal(result.pending[0].reason, reason);
      assert.ok(result.diagnostics.length > 0);
    });
  }
});

test('PAX size overrides the header size for the member data region', async () => {
  const data = Buffer.concat([Buffer.from('DATA'), Buffer.alloc(596)]);
  const source = archiveOf(
    member('PaxHeader', Buffer.concat([pax('path', 'f.bin'), pax('size', '600')]), 'x'),
    header('f.bin', 4),
    data,
    Buffer.alloc((512 - data.length % 512) % 512),
    member('g.bin', Buffer.from('GG')),
  );
  await run(source, async result => {
    assert.equal(result.status, 'complete');
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0].logicalSize, 600);
    assert.equal(result.records[0].storedSize, 600);
    assert.equal(result.records[0].logicalSha256, digest(data));
    assert.equal(result.records[1].path, 'g.bin');
  });
});

test('a missing end marker keeps the run from being complete', async () => {
  const source = { name: 'open.tar', bytes: member('only.bin', Buffer.from('ONLY')), close: async () => {} };
  await run(source, async result => {
    assert.equal(result.status, 'incomplete');
    assert.equal(result.records.length, 1);
    assert.equal(result.diagnostics.at(-1).code, 'missing-end-marker');
  });
});

test('duplicate paths are collected as separate occurrences sharing content objects', async () => {
  const source = await fixture('duplicate');
  await run(source, async (result, store) => {
    assert.equal(result.status, 'complete');
    const [first, second] = result.records;
    assert.equal(first.path, second.path);
    assert.equal(first.payload, second.payload);
    assert.notEqual(first.headerEvidence, second.headerEvidence);
    assert.deepEqual([first.sequence, second.sequence], [0, 1]);
    assert.equal(store.list('deliveries').length, 2);
  });
});
