// PAX extended header records: "<decimal length> <key>=<value>\n".
// The length prefix counts bytes (not characters), so UTF-8 paths such as
// 站点/observations.bin must be measured after encoding, never by string length.

export class PaxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaxError';
  }
}

export function paxAttributes(bytes) {
  const attributes = {};
  let position = 0;
  while (position < bytes.length) {
    const space = bytes.indexOf(0x20, position);
    if (space === -1) throw new PaxError(`PAX record at byte ${position} has no length separator`);
    const lengthText = bytes.subarray(position, space).toString('ascii');
    if (!/^[0-9]+$/.test(lengthText)) throw new PaxError(`PAX record at byte ${position} has a non-decimal length`);
    const length = Number(lengthText);
    const recordEnd = position + length;
    if (!Number.isSafeInteger(length) || length <= space - position + 2 || recordEnd > bytes.length) {
      throw new PaxError(`PAX record at byte ${position} declares an impossible length ${lengthText}`);
    }
    if (bytes[recordEnd - 1] !== 0x0a) throw new PaxError(`PAX record at byte ${position} is not LF terminated`);
    const body = bytes.subarray(space + 1, recordEnd - 1).toString('utf8');
    const equals = body.indexOf('=');
    if (equals === -1) throw new PaxError(`PAX record at byte ${position} has no key=value pair`);
    attributes[body.slice(0, equals)] = body.slice(equals + 1);
    position = recordEnd;
  }
  return attributes;
}
