import sharp from "sharp";

// Test-only image fixtures.

export async function patternJpeg(
  kind: "vertical" | "horizontal",
  opts: { exifDate?: string } = {},
): Promise<Buffer> {
  const width = 32;
  const height = 32;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = kind === "vertical" ? x >= 16 : y >= 16;
      const i = (y * width + x) * 3;
      const v = on ? 255 : 0;
      raw[i] = v;
      raw[i + 1] = v;
      raw[i + 2] = v;
    }
  }
  const image = sharp(raw, { raw: { width, height, channels: 3 } });
  if (opts.exifDate) {
    image.withExif({ IFD0: { DateTime: opts.exifDate } });
  }
  return image.jpeg().toBuffer();
}

// An iPhone-style HEIC header followed by an uncompressed EXIF timestamp.
// Prebuilt sharp cannot decode HEVC, which is exactly the case to survive.
export function fakeHeic(seed = 7): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypheic", "latin1"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("mif1heic", "latin1"),
    Buffer.alloc(64),
    Buffer.from("Exif\0\0DateTimeOriginal\x002026:09:19 08:15:00\0", "latin1"),
    Buffer.alloc(64, seed),
  ]);
}
