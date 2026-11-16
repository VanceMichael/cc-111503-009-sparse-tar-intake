export function tarHeader(bytes) {
  if (bytes.length !== 512) throw new Error('tar header must be 512 bytes');
  if (bytes.every(value => value === 0)) return { end: true };
  const string = (start, length) => bytes.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  const octal = (start, length) => {
    const value = string(start, length).trim();
    if (!/^[0-7]+$/.test(value)) throw new Error('invalid octal field');
    const parsed = parseInt(value, 8);
    if (!Number.isSafeInteger(parsed)) throw new Error('octal field is out of range');
    return parsed;
  };
  const copy = Buffer.from(bytes); copy.fill(32, 148, 156);
  if (copy.reduce((sum, value) => sum + value, 0) !== octal(148, 8)) throw new Error('tar checksum mismatch');
  const prefix = string(345, 155); const name = string(0, 100);
  return { end: false, path: prefix ? prefix + '/' + name : name, size: octal(124, 12),
    type: string(156, 1) || '0', magic: string(257, 6) };
}
