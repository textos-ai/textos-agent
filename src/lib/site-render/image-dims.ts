// Intrinsic dimension extraction from image bytes.
//
// Parsed server-side at upload so `width`/`height`/`bytes` are recorded from the
// file itself rather than trusted from the client. A readiness rule needs them
// later (OG images have a required size, and a hero background below a
// threshold looks wrong at full bleed).
//
// Pure byte parsing — no dependency, no decode, works in a Worker. Covers the
// four formats a browser file picker realistically yields for a website.
// Video dimensions are NOT parsed here (MP4 atom walking is a different job);
// the client supplies them from the <video> element and they are validated as
// plausible integers.

export interface Dims { width: number; height: number }

/** PNG: IHDR is always the first chunk — width/height at bytes 16..24. */
function png(b: DataView): Dims | null {
  if (b.byteLength < 24) return null;
  if (b.getUint32(0) !== 0x89504e47 || b.getUint32(4) !== 0x0d0a1a0a) return null;
  return { width: b.getUint32(16), height: b.getUint32(20) };
}

/** GIF87a / GIF89a: little-endian width/height at bytes 6..10. */
function gif(b: DataView): Dims | null {
  if (b.byteLength < 10) return null;
  if (b.getUint8(0) !== 0x47 || b.getUint8(1) !== 0x49 || b.getUint8(2) !== 0x46) return null;
  return { width: b.getUint16(6, true), height: b.getUint16(8, true) };
}

/** JPEG: walk segment markers to the SOFn frame header. */
function jpeg(b: DataView): Dims | null {
  if (b.byteLength < 4) return null;
  if (b.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 9 < b.byteLength) {
    if (b.getUint8(off) !== 0xff) { off++; continue; }
    const marker = b.getUint8(off + 1);
    // SOF0..SOF15, excluding DHT(c4), JPG(c8), DAC(cc) which are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.getUint16(off + 5), width: b.getUint16(off + 7) };
    }
    const len = b.getUint16(off + 2);
    if (len < 2) return null;
    off += 2 + len;
  }
  return null;
}

/** WebP: RIFF container, three sub-formats (lossy VP8, lossless VP8L, VP8X). */
function webp(b: DataView): Dims | null {
  if (b.byteLength < 30) return null;
  if (b.getUint32(0) !== 0x52494646) return null;       // "RIFF"
  if (b.getUint32(8) !== 0x57454250) return null;       // "WEBP"
  const fourcc = b.getUint32(12);
  if (fourcc === 0x56503820) {                          // "VP8 " lossy
    return { width: b.getUint16(26, true) & 0x3fff, height: b.getUint16(28, true) & 0x3fff };
  }
  if (fourcc === 0x5650384c) {                          // "VP8L" lossless
    const bits = b.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 0x56503858) {                          // "VP8X" extended
    const w = b.getUint8(24) | (b.getUint8(25) << 8) | (b.getUint8(26) << 16);
    const h = b.getUint8(27) | (b.getUint8(28) << 8) | (b.getUint8(29) << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

/** Best-effort intrinsic size. Returns null for SVG and unknown formats. */
export function imageDimensions(buf: ArrayBuffer): Dims | null {
  const b = new DataView(buf);
  for (const parse of [png, jpeg, gif, webp]) {
    try {
      const d = parse(b);
      if (d && d.width > 0 && d.height > 0) return d;
    } catch { /* try the next parser */ }
  }
  return null;
}

export const ALLOWED_IMAGE = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/avif",
]);
export const ALLOWED_VIDEO = new Set([
  "video/mp4", "video/webm",
]);

export function extensionFor(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "image/svg+xml": "svg", "image/avif": "avif", "video/mp4": "mp4", "video/webm": "webm",
  };
  return map[mime] ?? "bin";
}
