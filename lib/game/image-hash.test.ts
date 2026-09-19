import { describe, expect, it } from "vitest";
import { fakeHeic, patternJpeg } from "@/lib/test/images";
import {
  exifTakenAtFromBuffer,
  imageFingerprint,
  imageTakenAt,
  perceptualHash,
  sniffImageMime,
} from "./image-hash";

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

describe("undecodable photos (HEIC)", () => {
  it("sniffs the real type from bytes", async () => {
    expect(sniffImageMime(fakeHeic())).toBe("image/heic");
    expect(sniffImageMime(await patternJpeg("vertical"))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("not an image"))).toBeNull();
  });

  it("falls back to an exact hash instead of throwing", async () => {
    await expect(perceptualHash(fakeHeic())).rejects.toThrow();
    const a = await imageFingerprint(fakeHeic());
    const b = await imageFingerprint(fakeHeic());
    expect(a.kind).toBe("exact");
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash);
    expect((await imageFingerprint(fakeHeic(9))).hash).not.toBe(a.hash);
    const jpeg = await imageFingerprint(await patternJpeg("vertical"));
    expect(jpeg.kind).toBe("perceptual");
  });

  it("still reads the EXIF timestamp from the raw bytes", async () => {
    expect((await imageTakenAt(fakeHeic()))?.toISOString()).toBe(
      "2026-09-19T08:15:00.000Z",
    );
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
