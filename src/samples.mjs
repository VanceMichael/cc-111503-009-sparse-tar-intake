function header(name, size, type = '0') {
  const bytes = Buffer.alloc(512);
  bytes.write(name, 0, 100); bytes.write('0000644\0', 100); bytes.write('0001750\0', 108); bytes.write('0001750\0', 116);
  bytes.write(size.toString(8).padStart(11, '0') + '\0', 124); bytes.write('00000000001\0', 136);
  bytes.fill(32, 148, 156); bytes.write(type, 156); bytes.write('ustar\0', 257); bytes.write('00', 263);
  const checksum = bytes.reduce((sum, value) => sum + value, 0);
  bytes.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148); return bytes;
}
function member(name, bytes, type = '0') {
  return Buffer.concat([header(name, bytes.length, type), bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
export function pax(key, value) {
  const content = Buffer.from(key + '=' + value + '\n'); let length = content.length + 2;
  while (Buffer.byteLength(String(length)) + 1 + content.length !== length) length = Buffer.byteLength(String(length)) + 1 + content.length;
  return Buffer.concat([Buffer.from(length + ' '), content]);
}
export function archive(scenario = 'normal') {
  const name = '站点/observations.bin';
  const attributes = Buffer.concat([pax('path', name), pax('GNU.sparse.major', '1'), pax('GNU.sparse.minor', '0'),
    pax('GNU.sparse.realsize', '8192'), pax('GNU.sparse.name', name)]);
  const map = Buffer.alloc(512);
  map.write(scenario === 'overlap' ? '2\n0\n4\n2\n4\n' : '2\n0\n4\n4096\n4\n');
  const sparse = member('GNUSparseFile', Buffer.concat([map, Buffer.from('ABCDWXYZ')]));
  const parts = [member('PaxHeader', attributes, 'x'), sparse];
  if (scenario === 'duplicate') parts.push(member('PaxHeader2', attributes, 'x'), sparse);
  parts.push(Buffer.alloc(1024)); const bytes = Buffer.concat(parts);
  return scenario === 'truncated' ? bytes.subarray(0, 512 * 3 + 515) : bytes;
}
export async function fixture(scenario = 'normal') {
  const bytes = archive(scenario);
  return { name: scenario + '.tar', bytes, close: async () => {},
    async * chunks() { for (let offset = 0; offset < bytes.length; offset += 73) yield bytes.subarray(offset, offset + 73); } };
}
