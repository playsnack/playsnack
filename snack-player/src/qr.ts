// The invite link as a QR code, for friends in the same place to scan off the
// host's screen. Pure (no DOM): the matrix and its SVG path are unit-tested in
// Node, decoded back with a QR reader (snack-player/test/qr.test.ts).
// Only the QR sheet imports this, and the sheet is loaded when opened, so play
// links never download the encoder (qrcode-generator, MIT, pinned exact).
import qrcode from "qrcode-generator";

/** Modules of white border around the code — the 4 the QR spec asks scanners to get. */
export const QUIET_ZONE = 4;
/**
 * The biggest code we draw: version 20 (97 modules) at error level M holds 666 bytes.
 * A friends link is ~60 bytes (version 3–4). A made app's link carries the whole
 * app (#d=…) and can be far longer: drawn at phone size, its modules would be too
 * small to scan, so it gets no QR (the sheet says so and keeps "링크 복사").
 */
export const MAX_VERSION = 20;

export type QrMatrix = {
  /** Modules per side, without the quiet zone. */
  size: number;
  dark: (row: number, col: number) => boolean;
};

/** The QR matrix for `text` (UTF-8 bytes, error level M), or null when it would be too dense to scan off a phone. */
export function qrMatrix(text: string): QrMatrix | null {
  const qr = qrcode(0, "M"); // 0 = the smallest version that fits
  // The encoder's Byte mode keeps the low 8 bits of each char, so hand it the UTF-8 bytes as chars.
  const utf8 = new TextEncoder().encode(text);
  if (utf8.length > 3000) return null; // over what version 40 holds; also keeps the spread below small
  const bytes = String.fromCharCode(...utf8);
  try {
    qr.addData(bytes, "Byte");
    qr.make();
  } catch {
    return null; // more than version 40 can hold
  }
  const size = qr.getModuleCount();
  if (size > 17 + 4 * MAX_VERSION) return null;
  return { size, dark: (r, c) => qr.isDark(r, c) };
}

/**
 * One SVG path for every dark module (runs of a row merged into one rect), in a
 * viewBox of `size + 2 × QUIET_ZONE` units with the quiet zone included.
 */
export function qrPath(m: QrMatrix): string {
  let d = "";
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.dark(r, c)) { c++; continue; }
      const start = c;
      while (c < m.size && m.dark(r, c)) c++;
      d += `M${start + QUIET_ZONE} ${r + QUIET_ZONE}h${c - start}v1h${start - c}z`;
    }
  }
  return d;
}
