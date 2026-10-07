// iOS-HIG-flavored Bite component library, themed with our black+lime tokens.
// Injected into every generated doc (builder.mjs) so the AI only references
// components by name ({ "use": "Button", "props": { … } }) and never
// hand-positions their internals — dimensions are fixed here, in code.
//
// Components are prop-driven LEAVES (Bite components have no slots). Containers
// that hold content (Page/Card/List/Grid) are taught as box patterns in
// prompt.mjs instead.

// ── Design tokens — derived from the SSOT (tokens.mjs). "Mini-Block Arcade":
// sharp corners (radius 0), 2px block borders, blur:0 hard offset shadow. ──────
import { TOKENS as DS } from "./tokens.mjs";
export const TOKENS = {
  bg:          DS.color.bg,
  surface:     DS.color.surface,
  surfaceTop:  DS.color.surface2,
  border:      DS.color.borderBlock, // thick 2px block border
  hairline:    DS.color.hairline,    // 1px divider only
  accent:      DS.color.accent,      // lime
  onAccent:    DS.color.accentInk,   // dark text on lime
  text:        DS.color.ink,
  textMuted:   DS.color.inkMuted,
  danger:      DS.color.roster1,
  // iOS HIG dimensions (logical px @1x)
  safeTop:     DS.layout.safeTop,
  safeBottom:  DS.layout.safeBottom,
  margin:      DS.layout.margin,
  navH:        DS.layout.navH,
  tabH:        49,
  rowH:        DS.layout.rowH,
  btnH:        DS.layout.btnH,
  tap:         DS.layout.tap,
  radius:      DS.radius.block,      // 0 — sharp block corner
  border2:     DS.border.block,      // 2 — block border width
};
const T = TOKENS;
const HARD_SHADOW = { x: 0, y: DS.shadow.hardY, blur: 0, color: DS.color.shadow };
const radius = T.radius ? { radius: T.radius } : {}; // block corners are square (0)

// Sizing inside the library follows the Bite rules: a column child stretches to
// the full width by default, so roots omit width and carry a height (fixed or hug).
export const COMPONENTS = {
  NavBar: {
    description: "iOS top bar for the top of a page. props: title, subtitle.",
    props: { title: "", subtitle: "" },
    view: {
      box: "column", gap: 2,
      children: [
        { text: "{props.title}", font: "display", size: 28, color: T.text },
        { text: "{props.subtitle}", size: 15, weight: 500, color: T.textMuted, show: "props.subtitle != ''" },
      ],
    },
  },

  Button: {
    description: "Filled lime primary button, 50pt tall. Give the INSTANCE an onTap. props: label.",
    props: { label: "확인" },
    view: {
      box: "row", height: T.btnH, justify: "center", align: "center", fill: T.accent, ...radius,
      stroke: { color: T.onAccent, width: T.border2 }, shadow: HARD_SHADOW,
      children: [{ text: "{props.label}", size: 17, weight: 700, color: T.onAccent }],
    },
  },

  GhostButton: {
    description: "Outlined secondary button, 50pt tall. props: label.",
    props: { label: "취소" },
    view: {
      box: "row", height: T.btnH, justify: "center", align: "center", fill: T.surfaceTop, ...radius,
      stroke: { color: T.border, width: T.border2 }, shadow: HARD_SHADOW,
      children: [{ text: "{props.label}", size: 17, weight: 600, color: T.text }],
    },
  },

  Fab: {
    description: "56pt circular floating button; place it in a free box with x/y. props: icon (emoji/short glyph).",
    props: { icon: "+" },
    view: {
      box: "row", width: 56, height: 56, radius: "full", justify: "center", align: "center", fill: T.accent,
      shadow: { x: 0, y: 6, blur: 20, color: "#00000066" },
      children: [{ text: "{props.icon}", size: 26, weight: 700, color: T.onAccent }],
    },
  },

  StatCard: {
    description: "Surface card with a big VALUE under a small LABEL. props: label, value (pass a template like \"{score}점\" to make it live).",
    props: { label: "", value: "0" },
    view: {
      box: "column", gap: 6, pad: 20, fill: T.surface, ...radius,
      children: [
        { text: "{props.label}", size: 14, weight: 600, color: T.textMuted },
        { text: "{props.value}", font: "display", size: 40, color: T.text, lines: 1 },
      ],
    },
  },

  OptionCard: {
    description: "Tappable choice card (vote / this-or-that / quiz answer). Put onTap on the INSTANCE. props: label, accent (true = lime highlight, e.g. the picked option).",
    props: { label: "", accent: false },
    view: {
      box: "row", height: 88, pad: 12, justify: "center", align: "center", ...radius,
      fill: `{props.accent ? '${T.accent}' : '${T.surface}'}`,
      stroke: { color: T.border, width: T.border2 }, shadow: HARD_SHADOW,
      children: [{ text: "{props.label}", width: "fill", align: "center", size: 18, weight: 700, color: `{props.accent ? '${T.onAccent}' : '${T.text}'}`, lines: 3 }],
    },
  },

  ResultBar: {
    description: "Horizontal live-tally bar. props: label, pct (0..100), value (text at the right). Pass pct as a template, e.g. \"{round(votesByOption.A / max(1, votesByOption.A + votesByOption.B) * 100)}\".",
    props: { label: "", pct: 0, value: "" },
    view: {
      box: "column", gap: 8,
      children: [
        {
          box: "row", justify: "between", align: "center",
          children: [
            { text: "{props.label}", size: 15, weight: 600, color: T.text },
            { text: "{props.value}", size: 15, weight: 700, color: T.accent },
          ],
        },
        {
          box: "row", height: 10, radius: 5, fill: T.surfaceTop, clip: true,
          children: [
            { height: 10, grow: "{clamp(num(props.pct), 0, 100)}", fill: T.accent },
            { height: 10, grow: "{100 - clamp(num(props.pct), 0, 100)}" },
          ],
        },
      ],
    },
  },

  Chip: {
    description: "Small pill/tag. props: label.",
    props: { label: "" },
    view: {
      box: "row", width: "hug", height: 30, pad: [0, 12], justify: "center", align: "center", fill: T.surfaceTop,
      stroke: { color: T.border, width: 1 },
      children: [{ text: "{props.label}", size: 13, weight: 600, color: T.textMuted }],
    },
  },

  Avatar: {
    description: "Circular 44pt avatar. props: glyph (emoji or one initial).",
    props: { glyph: "🙂" },
    view: {
      box: "row", width: 44, height: 44, radius: "full", justify: "center", align: "center", fill: T.surfaceTop,
      children: [{ text: "{props.glyph}", size: 20, weight: 700, color: T.text }],
    },
  },
};

// ── Person cards: a face-free way to show real people (no portrait rights).
// The avatar is a 5×5 mirrored block pattern derived from the name, so the same
// person always gets the same mark, in one of the option-roster colors.
const AVATAR_COLORS = `['${DS.color.roster1}','${DS.color.roster2}','${DS.color.roster3}','${DS.color.roster4}']`;
const AVATAR_BIT = "floor(index / 5) * 3 + min(index % 5, 4 - index % 5)";
COMPONENTS.BlockAvatar = {
  description: "Face-free avatar: a 5×5 mirrored pixel pattern + color derived from a name (same name → same mark). Use instead of photos of real people. props: seed (the name), size (px, multiple of 5).",
  props: { seed: "", size: 120 },
  view: {
    box: "grid", columns: 5, width: "{props.size}", height: "{props.size}", each: "range(25)",
    children: [{
      height: "{props.size / 5}",
      fill: `{floor(hash(props.seed) / pow(2, ${AVATAR_BIT})) % 2 == 1 ? ${AVATAR_COLORS}[floor(hash(props.seed) / pow(2, 20)) % 4] : '${T.surfaceTop}'}`,
    }],
  },
};
COMPONENTS.PersonCard = {
  description: "Trading card for a real person WITHOUT a photo: BlockAvatar + big pixel name + chips. Fill the card's box (give the instance width/height). props: name, group (shown as a chip if set), rookie (bool → '신인' chip).",
  props: { name: "", group: "", rookie: false },
  view: {
    box: "column", pad: 16, gap: 12, align: "center", justify: "center", fill: T.surface, ...radius,
    stroke: { color: T.border, width: T.border2 }, shadow: HARD_SHADOW,
    children: [
      { use: "BlockAvatar", props: { seed: "{props.name}", size: 120 } },
      { text: "{props.name}", font: "display", size: 30, color: T.text, align: "center", lines: 1 },
      {
        box: "row", gap: 6, justify: "center", show: "props.group != '' || props.rookie",
        children: [
          { use: "Chip", props: { label: "{props.group}" }, show: "props.group != ''" },
          { use: "Chip", props: { label: "신인" }, show: "props.rookie" },
        ],
      },
    ],
  },
};

// Names the prompt is allowed to reference.
export const COMPONENT_IDS = Object.keys(COMPONENTS);

// Merge the library into a generated doc (idempotent). Only components the doc
// actually uses are added, and a doc's own definition of a name wins.
export function injectLibrary(doc) {
  if (!doc || typeof doc !== "object" || !doc.view) return doc;
  const scan = (node, used) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.use === "string") used.add(node.use);
    (node.children ?? []).forEach((c) => scan(c, used));
  };
  // Library components may use other library components (PersonCard → BlockAvatar,
  // Chip), so keep adding until every referenced name is defined.
  for (let round = 0; round < 4; round++) {
    const used = new Set();
    scan(doc.view, used);
    for (const def of Object.values(doc.components ?? {})) scan(def?.view, used);
    const missing = [...used].filter((n) => !doc.components?.[n] && COMPONENTS[n]);
    if (!missing.length) break;
    doc.components = { ...(doc.components ?? {}) };
    for (const n of missing) {
      const { props, view } = COMPONENTS[n];
      doc.components[n] = structuredClone({ props, view });
    }
  }
  return doc;
}
