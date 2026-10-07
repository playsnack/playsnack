// WCAG relative-luminance contrast ratio between two colors.
// Used by content-quality.mjs label-contrast check (FR-004, research R2; min 4.5).

// Parse "#rgb" / "#rrggbb" / "rgb(r,g,b)" / "rgba(...)" -> {r,g,b} 0..255, or null.
export function parseColor(c) {
  if (typeof c !== "string") return null;
  let s = c.trim().toLowerCase();
  const named = { white: "#ffffff", black: "#000000" };
  if (named[s]) s = named[s];
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = [...m[1]].map((h) => parseInt(h + h, 16));
    return { r, g, b };
  }
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  m = s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  return null;
}

function relLuminance({ r, g, b }) {
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Contrast ratio 1..21. Returns null if either color is unparseable.
export function contrastRatio(fg, bg) {
  const a = parseColor(fg), b = parseColor(bg);
  if (!a || !b) return null;
  const la = relLuminance(a), lb = relLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const MIN_CONTRAST = 4.5; // WCAG AA body text
