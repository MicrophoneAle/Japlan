import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { exifTakenAtFromBuffer, perceptualHash } from "./image-hash";

async function patternJpeg(kind: "vertical" | "horizontal"): Promise<Buffer> {
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
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

describe("perceptualHash", () => {
  it("is stable for the same image and different across images", async () => {
    const vertical = await patternJpeg("vertical");
    const horizontal = await patternJpeg("horizontal");
    const a = await perceptualHash(vertical);
    const b = await perceptualHash(vertical);
    const c = await perceptualHash(horizontal);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("EXIF timestamp", () => {
  it("reads DateTimeOriginal-style ASCII from an EXIF buffer", () => {
    const taken = exifTakenAtFromBuffer(
      Buffer.from("DateTimeOriginal\x002026:09:19 08:15:00", "latin1"),
    );
    expect(taken?.toISOString()).toBe("2026-09-19T08:15:00.000Z");
  });
});
