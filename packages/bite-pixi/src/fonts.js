// Register the shipped font faces with the browser and wait for the ones a
// document uses, so the first frame draws with the same metrics layout used.
import { faceFor } from "@snack/bite-layout";

export const FAMILY = {
  body: "Bite Body",
  display: "Bite Display",
};
const EMOJI_FALLBACK = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
export const fontFamily = (font) => `"${font === "display" ? FAMILY.display : FAMILY.body}", ${EMOJI_FALLBACK}`;

const FILES = {
  body: (w) => `pretendard-${w}.woff2`,
  display: (w) => (w >= 700 ? "galmuri11-bold.woff2" : "galmuri11.woff2"),
};

const loaded = new Map();

function facesUsed(doc) {
  const used = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if ("text" in node) {
      const font = node.font === "display" ? "display" : "body";
      // A templated weight can be anything: load the face for the literal or the default.
      const weight = typeof node.weight === "number" ? node.weight : undefined;
      used.add(`${font}:${faceFor(font, weight).weight}`);
    }
    for (const c of node.children ?? []) visit(c);
  };
  visit(doc.view);
  for (const def of Object.values(doc.components ?? {})) visit(def.view);
  return used;
}

/** Load every face the document references. Resolves even if a font fails. */
export async function loadFonts(doc, base = "/fonts") {
  const jobs = [];
  for (const id of facesUsed(doc)) {
    const [font, weight] = id.split(":");
    if (!loaded.has(id)) {
      const face = new FontFace(FAMILY[font], `url(${base}/${FILES[font](Number(weight))}) format("woff2")`, { weight });
      document.fonts.add(face);
      loaded.set(id, face.load().catch((e) => console.warn(`[bite] font ${id} failed`, e)));
    }
    jobs.push(loaded.get(id));
  }
  await Promise.all(jobs);
}
