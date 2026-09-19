import { createHash } from "node:crypto";
import sharp from "sharp";

const EXIF_DATETIME =
  /(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/;

export function exifTakenAtFromBuffer(exif: Buffer): Date | null {
  const text = exif.toString("latin1");
  const match = text.match(EXIF_DATETIME);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const taken = new Date(iso);
  return Number.isNaN(taken.getTime()) ? null : taken;
}

// Identify the image from its bytes, not the declared mime. iMessage photos
// are usually HEIC, and the declared type can be missing or generic.
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      return "image/heic";
    }
  }
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString("latin1") === "GIF") {
    return "image/gif";
  }
  return null;
}

export async function imageTakenAt(bytes: Buffer): Promise<Date | null> {
  try {
    const meta = await sharp(bytes).metadata();
    if (meta.exif) return exifTakenAtFromBuffer(meta.exif);
  } catch {
    // Prebuilt sharp cannot decode HEIC. The EXIF block sits uncompressed in
    // the file, so read the timestamp straight from the bytes instead.
  }
  return exifTakenAtFromBuffer(bytes);
}

export async function perceptualHash(bytes: Buffer): Promise<string> {
  const { data } = await sharp(bytes)
    .grayscale()
    .resize(8, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  for (const value of data) sum += value;
  const avg = sum / data.length;
  let bits = "";
  for (const value of data) bits += value >= avg ? "1" : "0";
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

export type ImageFingerprint = {
  hash: string;
  kind: "perceptual" | "exact";
};

// Perceptual hash when sharp can decode the image; otherwise an exact SHA-256
// of the bytes (prefixed, so it never collides with a perceptual hash). An
// undecodable photo used to throw here and take the whole claim down with it.
export async function imageFingerprint(bytes: Buffer): Promise<ImageFingerprint> {
  try {
    return { hash: await perceptualHash(bytes), kind: "perceptual" };
  } catch {
    const digest = createHash("sha256").update(bytes).digest("hex");
    return { hash: `sha256:${digest}`, kind: "exact" };
  }
}
