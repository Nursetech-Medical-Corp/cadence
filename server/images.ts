// Pictures sent as data URLs (logos, headers): decoded and checked by their first bytes, not just their label.
import {Invalid} from './errors.ts';

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  jpeg: b => b[0] === 0xff && b[1] === 0xd8,
  png: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
/** The image bytes of a data URL of one of these types, or Invalid. */
export function decodeImage(dataUrl: unknown, types: (keyof typeof MAGIC)[], maxBytes: number): Buffer {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!m || !types.includes(m[1])) throw new Invalid(`Send a ${types.map(t => t.toUpperCase()).join(', ')} picture`);
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > maxBytes) throw new Invalid('The picture is too large');
  if (!MAGIC[m[1]](bytes)) throw new Invalid('That file is not the picture it says it is');
  return bytes;
}
