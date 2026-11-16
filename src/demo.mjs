import { fixture } from './samples.mjs';
import { collect, preview } from './intake.mjs';
import { Inbox } from './store.mjs';

const source = await fixture();
const store = new Inbox();
try {
  // preview() only reads the physical member list; it does not consume the
  // source, so the same delivery can then be collected.
  const before = await preview(source, store);
  console.log(JSON.stringify({ preview: before }, null, 2));

  const result = await collect(source, store);
  const members = result.records.map(record => ({
    order: record.order,
    path: record.path,
    headerOffset: record.headerOffset,
    dataOffset: record.dataOffset,
    mapSize: record.mapSize,
    physicalSize: record.physicalSize,
    storedSize: record.storedSize,
    logicalSize: record.logicalSize,
    logicalSha256: record.logicalSha256,
    physicalSha256: record.physicalSha256,
    extents: record.extents.map(extent => ({
      offset: extent.offset,
      length: extent.length,
      sourceOffset: extent.sourceOffset,
      sha256: extent.sha256,
      evidence: extent.evidence
    })),
    holes: record.holes,
    layout: record.layout,
    evidence: record.evidence
  }));
  console.log(JSON.stringify({
    collection: {
      status: result.status,
      mode: result.mode,
      package: result.package,
      records: members,
      pending: result.pending,
      diagnostics: result.diagnostics
    }
  }, null, 2));
} finally { store.close(); await source.close(); }
