import test from 'node:test';
import assert from 'node:assert/strict';
import { tarHeader } from '../src/tar-header.mjs';
import { fixture, pax } from '../src/samples.mjs';
import { preview } from '../src/receipt.mjs';
import { Inbox } from '../src/store.mjs';

test('physical preview retains extension members rather than pretending to decode them', async () => {
  const source = await fixture(); const store = new Inbox();
  try {
    const result = await preview(source, store); assert.equal(result.members[0].type, 'x');
    assert.equal(result.members[1].size, 520); assert.equal(result.members[1].path, 'GNUSparseFile');
  } finally { store.close(); }
});
test('PAX record length counts bytes rather than characters', () => {
  const bytes = pax('path', '站点/a'); assert.equal(Number(bytes.toString().split(' ')[0]), bytes.length);
});
test('corrupt headers are not accepted as members', async () => {
  const source = await fixture(); const bytes = Buffer.from(source.bytes.subarray(0, 512)); bytes[0] ^= 1;
  assert.throws(() => tarHeader(bytes), /checksum/);
});
