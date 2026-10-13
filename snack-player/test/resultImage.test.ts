// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResultView } from "../src/quizResult.ts";
import {
  IMG_H, IMG_W, drawOps, ellipsize, glyphsNeeded, paintResultImage, planResultImage, wrapText,
  type Ctx2D, type Measure, type Op, type TextStyle,
} from "../src/resultImage.ts";
import { LONG_NICK, duo, group } from "./fixtures/quizResult.ts";

// A deterministic measurer: Hangul / emoji = 1 em, everything else 0.6 em.
const wide = (ch: string) => (ch.codePointAt(0)! >= 0x1100 ? 1 : 0.6);
const measure: Measure = (t, s) => Array.from(t).reduce((w, ch) => w + wide(ch) * s.size, 0);
const FAM = { body: '"Bite Body", "Bite Body Full", sans-serif', display: '"Bite Display", "Bite Display Full", monospace' };
const texts = (ops: Op[]) => ops.filter((o): o is Extract<Op, { kind: "text" }> => o.kind === "text");

/** Every text op fits its own box and the picture. */
function assertInside(ops: Op[]) {
  for (const o of texts(ops)) {
    const w = measure(o.text, o.style);
    assert.ok(w <= o.maxW + 0.01, `"${o.text}" ${w} > ${o.maxW}`);
    const left = o.align === "left" ? o.x : o.align === "right" ? o.x - w : o.x - w / 2;
    assert.ok(left >= 0 && left + w <= IMG_W, `"${o.text}" spills horizontally (${left}..${left + w})`);
    assert.ok(o.y >= 0 && o.y + o.style.size * 1.35 <= IMG_H, `"${o.text}" spills vertically (y ${o.y})`);
  }
}

test("1:1 picture: title, N/M, the line, the tier, highlights, app name + link", () => {
  const v = buildResultView({ ...duo, myNick: "지은" });
  const ops = planResultImage(v, measure, { appName: "PlaySnack", link: "playsnack.vercel.app/p/tpl-speed-trivia-score" });
  const all = texts(ops).map((o) => o.text);
  for (const want of ["민수 맞히기", "4/6", "지은은 민수를 4/6 맞혔어요", "꽤 친함 🙂", "PlaySnack", "playsnack.vercel.app/p/tpl-speed-trivia-score"]) {
    assert.ok(all.includes(want), `missing "${want}" in ${JSON.stringify(all)}`);
  }
  assert.ok(all.some((t) => t.startsWith("정답 · ")), "a highlighted question with the real answer");
  assertInside(ops);
});

test("group picture: ranking with honest ties and the leaver marked; ≤ 3 highlighted questions above the footer", () => {
  const v = buildResultView({ ...group, myNick: "하늘" });
  const ops = planResultImage(v, measure, { link: "playsnack.vercel.app/p/x" });
  const all = texts(ops).map((o) => o.text);
  assert.equal(all.filter((t) => t === "공동 1위").length, 2);
  assert.ok(all.includes("서준 (나감)"));
  assert.ok(all.includes(LONG_NICK), "a 10-grapheme nickname fits whole");
  const qs = all.filter((t) => /^Q\d+\./.test(t));
  assert.ok(qs.length >= 1 && qs.length <= 3, `highlights: ${qs.length}`);
  const foot = texts(ops).find((o) => o.text === "PlaySnack")!;
  for (const o of texts(ops)) if (o !== foot && o.text !== "playsnack.vercel.app/p/x") assert.ok(o.y < foot.y - 40, `"${o.text}" runs into the footer`);
  assertInside(ops);
});

test("the top answerer row is the lime hero; others are dark", () => {
  const v = buildResultView({ ...group });
  const rects = planResultImage(v, measure).filter((o) => o.kind === "rect") as Extract<Op, { kind: "rect" }>[];
  assert.equal(rects.filter((r) => r.color === "#D9FF00").length, 2, "both tied 1st rows");
});

test("a too-long name or line is cut with … , never drawn past its box", () => {
  const s: TextStyle = { font: "body", weight: 700, size: 40 };
  const cut = ellipsize("가".repeat(40), 300, s, measure);
  assert.ok(cut.endsWith("…"));
  assert.ok(measure(cut, s) <= 300);
  const lines = wrapText("아주 긴 제목이 여러 줄로 넘어가는 경우를 확인합니다 정말로 아주 길어요", 400, s, measure, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith("…"));
  for (const l of lines) assert.ok(measure(l, s) <= 400);
  // one word longer than a line breaks by grapheme
  assert.ok(wrapText("가".repeat(30), 400, s, measure, 5).length >= 3);
  // a huge nickname in the ranking is cut
  const v = buildResultView({ ...group, raceBoard: [{ nick: "👾".repeat(30), score: 9999 }, ...group.raceBoard!] });
  assertInside(planResultImage(v, measure));
});

test("glyphs: every drawn text (incl. a rare syllable 뷁) is loaded per face before painting; a failed load still paints", async () => {
  const v = buildResultView({ ...group, raceBoard: [{ nick: "뷁똠햏", score: 99999 }, ...group.raceBoard!] });
  const calls: [string, string][] = [];
  const painted: string[] = [];
  const ctx: Ctx2D & { fills: number } = {
    fillStyle: "", font: "", textAlign: "", textBaseline: "", fills: 0,
    fillRect() { this.fills++; },
    fillText(t: string) { painted.push(t); },
    measureText(t: string) { const m = /(\d+)px/.exec(this.font); return { width: measure(t, { font: "body", weight: 500, size: m ? Number(m[1]) : 16 }) }; },
  };
  const ops = await paintResultImage(ctx, v, { families: FAM, link: "x", load: async (f, t) => { calls.push([f, t]); if (f.includes("Display")) throw new Error("offline"); } });
  const loadedText = calls.map(([, t]) => t).join("");
  assert.ok(loadedText.includes("뷁똠햏"), "the nickname's glyphs were requested");
  assert.ok(calls.every(([f]) => f.includes("Full")), "the full face sits behind the subset in every font stack");
  const faces = new Set(calls.map(([f]) => f));
  assert.equal(faces.size, glyphsNeeded(ops, FAM).size, "one load per face");
  assert.ok(painted.some((t) => t.startsWith("뷁똠햏")), "painted even though one face failed to load");
  assert.ok(ctx.fills > 0);
});

test("drawOps paints rects and text with the op's font and alignment", () => {
  const log: string[] = [];
  const ctx: Ctx2D = {
    fillStyle: "", font: "", textAlign: "", textBaseline: "",
    fillRect: (x, y, w, h) => log.push(`rect ${x},${y},${w},${h}`),
    fillText(t, x, y) { log.push(`text ${t}@${x},${y} ${this.font} ${this.textAlign}`); },
    measureText: () => ({ width: 0 }),
  };
  drawOps(ctx, [
    { kind: "rect", x: 0, y: 0, w: 10, h: 10, color: "#000" },
    { kind: "text", text: "4/6", x: 540, y: 100, style: { font: "display", weight: 700, size: 168 }, color: "#D9FF00", align: "center", maxW: 920 },
  ], FAM);
  assert.deepEqual(log, ["rect 0,0,10,10", `text 4/6@540,100 700 168px ${FAM.display} center`]);
});
