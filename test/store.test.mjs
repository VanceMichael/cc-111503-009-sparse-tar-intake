import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox } from '../src/store.mjs';

test('raw evidence is idempotent and receipts survive reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-'));
  try {
    let store = new Inbox(join(directory, 'inbox.sqlite'));
    const first = store.saveEvidence('raw', { source: 'local' }, Buffer.from('payload'));
    assert.equal(first, store.saveEvidence('raw', { source: 'local' }, Buffer.from('payload')));
    store.put('runs', 'r1', { status: 'preview' }); store.close();
    store = new Inbox(join(directory, 'inbox.sqlite'));
    assert.equal(store.evidence().length, 1); assert.equal(store.list('runs')[0].status, 'preview'); store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
