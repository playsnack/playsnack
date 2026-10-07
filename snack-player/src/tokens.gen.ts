// ⚠️ AUTO-GENERATED from snack-server/src/tokens.mjs — DO NOT EDIT.
// Regenerate:  node snack-server/tools/gen-tokens.mjs  (also runs on player prebuild)
// SSOT for the "Mini-Block Arcade" design system (color/radius/space/shadow/font).

export const TOKENS = {
  "color": {
    "bg": "#0B0C0E",
    "surface": "#16181C",
    "surface2": "#1E2127",
    "hairline": "#2A2D33",
    "borderBlock": "#3A3F47",
    "ink": "#FFFFFF",
    "inkMuted": "#9AA3AF",
    "accent": "#D9FF00",
    "accentInk": "#0B0C0E",
    "live": "#22C55E",
    "roster1": "#FF5A5F",
    "roster2": "#4DA3FF",
    "roster3": "#FACC15",
    "roster4": "#B46CFF",
    "shadow": "#000000"
  },
  "radius": {
    "block": 0,
    "chip": 0,
    "bar": 0,
    "full": 999
  },
  "border": {
    "hairline": 1,
    "block": 2,
    "heavy": 3
  },
  "space": {
    "s1": 4,
    "s2": 8,
    "s3": 12,
    "s4": 16,
    "s5": 24,
    "s6": 32
  },
  "shadow": {
    "hardY": 6,
    "hardYsm": 5
  },
  "font": {
    "display": "\"Galmuri11\", \"Press Start 2P\", ui-monospace, monospace",
    "displayLatin": "\"Press Start 2P\", \"Galmuri11\", ui-monospace, monospace",
    "body": "-apple-system, \"Apple SD Gothic Neo\", \"Pretendard\", system-ui, \"Segoe UI\", Roboto, sans-serif"
  },
  "size": {
    "displayLg": 40,
    "displayMd": 28,
    "titleLg": 26,
    "titleMd": 21,
    "bodyLg": 17,
    "bodyMd": 15,
    "bodySm": 13,
    "caption": 12
  },
  "weight": {
    "display": 800,
    "strong": 700,
    "body": 600,
    "muted": 500
  },
  "layout": {
    "safeTop": 59,
    "safeBottom": 34,
    "margin": 16,
    "navH": 44,
    "rowH": 56,
    "btnH": 50,
    "tap": 44
  }
} as const;

/** color shorthand */
export const C = TOKENS.color;
/** spacing 4-grid shorthand */
export const S = TOKENS.space;
/** radius shorthand */
export const R = TOKENS.radius;

/** blur:0 hard offset shadow (the block signature) */
export const hardShadow = "0 6px 0 #000000";
export const hardShadowSm = "0 5px 0 #000000";
/** 8-bit pixel bevel: light top highlight + dark bottom — reads as a raised block on dark bg */
export const pixelBevel = "inset 2px 2px 0 rgba(255,255,255,0.10), inset -2px -2px 0 rgba(0,0,0,0.45)";
/** standard block depth = bevel + hard offset (use on cards/buttons) */
export const blockShadow = "inset 2px 2px 0 rgba(255,255,255,0.10), inset -2px -2px 0 rgba(0,0,0,0.45), 0 6px 0 #000000";
