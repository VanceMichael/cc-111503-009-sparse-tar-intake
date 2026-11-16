// PAX extended header records are length prefixed in *bytes*:
//   <decimal length><space><key>=<value><LF>
// The length includes its own decimal digits, the space and the trailing LF.

export class PaxError extends Error {}

export function parsePaxRecords(bytes) {
  const records = [];
  let position = 0;
  while (position < bytes.length) {
    // PAX writers sometimes leave NUL padding inside an over-sized x header.
    // Treat a run of NULs at the end as padding, but never as a record.
    if (bytes[position] === 0) {
      for (let index = position; index < bytes.length; index += 1) {
        if (bytes[index] !== 0) throw new PaxError('non-zero byte after PAX NUL padding');
      }
      break;
    }
    const space = bytes.indexOf(0x20, position);
    if (space < 0) throw new PaxError('PAX record has no length separator');
    const lengthText = bytes.subarray(position, space).toString('latin1');
    if (!/^[0-9]+$/.test(lengthText)) throw new PaxError('PAX record length is not decimal');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= 0) throw new PaxError('PAX record length is out of range');
    if (space - position !== String(length).length) throw new PaxError('PAX record length does not match its prefix');
    const end = position + length;
    if (end > bytes.length) throw new PaxError('PAX record exceeds extended header data');
    if (bytes[end - 1] !== 0x0a) throw new PaxError('PAX record does not end with LF');
    const body = bytes.subarray(space + 1, end - 1);
    const equals = body.indexOf(0x3d);
    if (equals <= 0) throw new PaxError('PAX record has no key=value pair');
    const key = body.subarray(0, equals).toString('utf8');
    if (!key) throw new PaxError('PAX record key is empty');
    const valueBytes = Buffer.from(body.subarray(equals + 1));
    records.push({ key, value: valueBytes.toString('utf8'), valueBytes });
    position = end;
  }
  return records;
}

export function paxNumber(value, key) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new PaxError('PAX ' + key + ' is not a non-negative decimal integer');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new PaxError('PAX ' + key + ' is out of range');
  return number;
}
