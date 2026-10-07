// content-quality gate (B). Checks content TRUTH / 정합 / 가독성 / dedup across
// templates. stdout JSON + exit 0/1. See contracts/content-quality.md, FR-004~009.
//   Usage: node snack-server/tools/content-quality.mjs [id ...]
import { listIds, loadDoc, categoryOf, questionSets, optionSets, textColorPairs, imageFields, stringLeaves, varInitials } from "./_doc.mjs";
import { chosungOf, matchesChosung } from "./_hangul.mjs";
import { contrastRatio, MIN_CONTRAST } from "./_contrast.mjs";
import { runGate } from "./_gate.mjs";

// Placeholder/filler names that must never ship (FR-008 filler-name).
const FILLER = ["민준", "서연", "홍길동", "김철수", "이영희", "아무개", "test", "tester", "예시", "샘플", "lorem", "ipsum", "aaa", "bbb", "ccc", "foo", "bar", "todo", "placeholder", "더미", "dummy"];

// Categories expected to show real-entity images in matchups (FR-007).
const IMAGE_CATEGORIES = new Set(["worldcup"]);

function checkChosung(doc, violations) {
  for (const q of questionSets(doc)) {
    if (!q.chosung) continue; // not a 초성 question
    // every option must share the 초성 pattern
    for (const opt of q.options) {
      if (!matchesChosung(opt, q.chosung)) {
        violations.push({ type: "chosung-mismatch", var: q.varId, qIdx: q.idx,
          chosung: q.chosung, option: opt, optionChosung: chosungOf(opt) });
      }
    }
    // the marked answer must itself match
    const ans = q.options[q.answer];
    if (ans != null && !matchesChosung(ans, q.chosung)) {
      violations.push({ type: "answer-chosung-mismatch", var: q.varId, qIdx: q.idx,
        chosung: q.chosung, answer: ans, answerChosung: chosungOf(ans) });
    }
  }
}

function checkFiller(doc, violations) {
  const strings = stringLeaves(varInitials(doc));
  for (const s of strings) {
    for (const f of FILLER) {
      if (s === f || s.toLowerCase() === f.toLowerCase()) {
        violations.push({ type: "filler-name", value: s });
      }
    }
  }
}

function checkImages(doc, id, violations) {
  if (!IMAGE_CATEGORIES.has(categoryOf(id))) return;
  const imgs = imageFields(doc);
  // Face-free person cards are the intended visual for real people (no portrait
  // rights) — a worldcup that uses them needs no photo.
  if (/"use"\s*:\s*"(PersonCard|BlockAvatar)"/.test(JSON.stringify(doc.view ?? {}))) return;
  // worldcup matchups must reference an image source; flag if NONE present.
  if (imgs.length === 0) {
    violations.push({ type: "missing-image", note: "worldcup with no image field — candidates render without photos" });
    return;
  }
  for (const f of imgs) {
    const v = f.value;
    if (v === "" || v == null) violations.push({ type: "missing-image", where: f.path });
  }
}

function checkContrast(doc, violations) {
  for (const p of textColorPairs(doc)) {
    if (!p.fg || !p.bg) continue;
    // Best case over the plausible backgrounds (see textColorPairs).
    const ratio = Math.max(...(p.bgs ?? [p.bg]).map((bg) => contrastRatio(p.fg, bg)));
    if (ratio != null && ratio < MIN_CONTRAST) {
      violations.push({ type: "label-contrast", layer: p.id, fg: p.fg, bg: p.bg,
        ratio: +ratio.toFixed(2), min: MIN_CONTRAST });
    }
  }
}

// Cross-template dedup (FR-008). Jaccard >= 0.8 on normalized option sets.
function norm(s) { return String(s).toLowerCase().replace(/\s+/g, "").replace(/[!?.,~]/g, ""); }
function jaccard(a, b) {
  const A = new Set(a.map(norm)), B = new Set(b.map(norm));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function main() {
  const argv = process.argv.slice(2);
  const ids = argv.length ? argv : listIds();
  const docs = ids.map((id) => ({ id, doc: loadDoc(id) }));

  // dedup pass: collect every option set, compare pairs across DIFFERENT templates
  const allSets = [];
  for (const { id, doc } of docs) for (const s of optionSets(doc, id)) allSets.push({ id, ...s });
  const dupByTemplate = new Map(); // id -> [{otherId, jaccard, label}]
  for (let i = 0; i < allSets.length; i++) for (let j = i + 1; j < allSets.length; j++) {
    if (allSets[i].id === allSets[j].id) continue;
    if (allSets[i].set.length < 3) continue;
    const sim = jaccard(allSets[i].set, allSets[j].set);
    if (sim >= 0.8) {
      for (const side of [[allSets[i], allSets[j]], [allSets[j], allSets[i]]]) {
        const arr = dupByTemplate.get(side[0].id) || [];
        arr.push({ otherId: side[1].id, jaccard: +sim.toFixed(2), label: side[0].label });
        dupByTemplate.set(side[0].id, arr);
      }
    }
  }

  const results = docs.map(({ id, doc }) => {
    const violations = [];
    checkChosung(doc, violations);
    checkFiller(doc, violations);
    checkImages(doc, id, violations);
    checkContrast(doc, violations);
    for (const d of dupByTemplate.get(id) || []) violations.push({ type: "dedup", ...d });
    return { id, category: categoryOf(id), ok: violations.length === 0, violations };
  });

  runGate("content-quality", results, (r) => r.ok,
    ({ failed, total }) => `content-quality: ${total - failed}/${total} clean${failed ? ` — ${failed} with violations` : ""}`);
}

main();
