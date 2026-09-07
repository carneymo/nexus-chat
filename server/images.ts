import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function parseImage(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Choose an image.');
  const { name, data } = value as Record<string, unknown>;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 200 ||
    name
      .split('')
      .some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
  )
    throw new Error('Invalid image filename.');
  if (
    typeof data !== 'string' ||
    data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new Error('Images must be no larger than 5 MB.');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error('Images must be no larger than 5 MB.');
  let mime = '';
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  )
    mime = 'image/png';
  else if (
    bytes.length >= 12 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    mime = 'image/jpeg';
  else if (
    bytes.length >= 13 &&
    ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  )
    mime = 'image/gif';
  else if (
    bytes.length >= 20 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    mime = 'image/webp';
  if (!mime) throw new Error('Choose a PNG, JPEG, GIF, or WebP image.');
  return {
    name: name.trim(),
    bytes,
    mime,
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}
