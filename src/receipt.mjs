import { tarHeader } from './tar-header.mjs';

export async function preview(source, store) {
  const evidence = store.saveEvidence('tar-package', { name: source.name }, source.bytes);
  const members = []; let offset = 0;
  while (offset + 512 <= source.bytes.length) {
    const header = tarHeader(source.bytes.subarray(offset, offset + 512));
    if (header.end) break;
    members.push({ ...header, headerOffset: offset, dataOffset: offset + 512 });
    offset += 512 + Math.ceil(header.size / 512) * 512;
  }
  return { mode: 'physical-member-preview', evidence, members };
}
