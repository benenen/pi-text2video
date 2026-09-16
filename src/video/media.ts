const MIME_BY_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export function extFor(mimeType: string): string {
  return MIME_BY_EXT[mimeType] ?? "mp4";
}

/** Sniff by magic bytes: services often label video bytes application/octet-stream. */
export function videoMimeType(buffer: Buffer): string | undefined {
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return "video/webm";
  return undefined;
}
