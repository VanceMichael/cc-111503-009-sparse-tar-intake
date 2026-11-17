// GNU sparse 1.0 (PAX GNU.sparse.major=1 minor=0) member layout:
// the map sits at the start of the member's stored data as decimal LF
// terminated lines (extent count, then alternating offset/length), padded to
// a 512 byte boundary; the payload is the concatenation of the extent bytes
// and GNU.sparse.realsize is the logical size. A corrupt map is reported, it
// is never repaired by inventing zero filled ranges.

export class SparseMapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SparseMapError';
  }
}

function safeDecimal(text, what) {
  if (!/^[0-9]+$/.test(text)) throw new SparseMapError(`sparse map ${what} is not decimal: ${JSON.stringify(text)}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new SparseMapError(`sparse map ${what} exceeds the verifiable integer range`);
  return value;
}

export function sparseMap(data, logicalSize) {
  let position = 0;
  const line = what => {
    const newline = data.indexOf(0x0a, position);
    if (newline === -1) throw new SparseMapError(`sparse map ${what} line is not LF terminated`);
    const value = safeDecimal(data.subarray(position, newline).toString('ascii'), what);
    position = newline + 1;
    return value;
  };

  const count = line('extent count');
  const extents = [];
  let previousEnd = 0;
  let stored = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = line(`extent ${index} offset`);
    const length = line(`extent ${index} length`);
    if (length <= 0) throw new SparseMapError(`sparse extent ${index} has a non-positive length`);
    if (offset < previousEnd) throw new SparseMapError(`sparse extent ${index} overlaps or is out of order`);
    if (length > logicalSize - offset) throw new SparseMapError(`sparse extent ${index} exceeds the logical size`);
    extents.push({ offset, length });
    previousEnd = offset + length;
    stored += length;
  }

  const mapPadded = Math.ceil(position / 512) * 512;
  if (mapPadded > data.length) throw new SparseMapError('sparse map padding exceeds the stored member data');
  if (stored !== data.length - mapPadded) {
    throw new SparseMapError(`sparse map declares ${stored} payload bytes but ${data.length - mapPadded} are stored`);
  }
  return { mapBytes: position, mapPadded, extents, payload: data.subarray(mapPadded) };
}
