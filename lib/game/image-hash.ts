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

export async function imageTakenAt(bytes: Buffer): Promise<Date | null> {
  const meta = await sharp(bytes).metadata();
  if (!meta.exif) return null;
  return exifTakenAtFromBuffer(meta.exif);
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
