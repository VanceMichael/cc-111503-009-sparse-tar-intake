import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/samples.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(scenario, check) {
  assert.equal(typeof intake.collect, 'function', 'collection entry is not available yet');
  const source = await fixture(scenario); const store = new Inbox();
  try {
    const result = await intake.collect(source, store);
    await check(result, source, store);
  } finally { store.close(); await source.close(); }
}

test('logical sparse content is not the physical map and payload concatenation', async () => {
  await run('normal', async result => {
    assert.equal(result.status, 'complete'); assert.equal(result.records.length, 1);
    const member = result.records[0]; assert.equal(member.path, '站点/observations.bin');
    assert.equal(member.logicalSize, 8192); assert.equal(member.storedSize, 8);
    assert.deepEqual(member.extents.map(row => [row.offset, row.length]), [[0, 4], [4096, 4]]);
    assert.equal(member.logicalSha256, '55e791bebccd3a183a01f03ef398554e7a75769fdc72b46a2d1756e1c1b12b84');
  });
});
test('duplicate paths remain separate archive occurrences', async () => {
  await run('duplicate', async result => { assert.equal(result.records.length, 2); assert.notEqual(result.records[0].headerOffset, result.records[1].headerOffset); });
});
for (const scenario of ['overlap', 'truncated']) {
  test(scenario + ' cannot be silently filled with zeros and published', async () => {
    await run(scenario, async result => { assert.notEqual(result.status, 'complete'); assert.equal(result.records.length, 0); });
  });
}
