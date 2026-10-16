// Room type (#143): the top-row chip (snack-player/src/roomType.ts), the lobby subtitle of the
// session templates (roomMode / roomPin, docs/bite-format.md §6.2), and "방장" only in friends
// rooms (public rooms have no host). Also #217's invite question (invite.ts askPinFirst).
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBite } from "../../packages/bite/src/index.js";
import { absBoxes, computeScene, initLayout } from "../../packages/bite-layout/src/index.js";
import { chipAction, leaveFriendsCopy, roomChip, roomKind, showRoomChip } from "../src/roomType.ts";
import { askPinFirst, invitePinAsked, INVITE_PIN_ASK } from "../src/invite.ts";
import { forTemplate } from "../src/spectate.ts";

test("chip: the room kind from the link, its label and what a tap does", () => {
  assert.equal(roomKind(null), "public");
  assert.equal(roomKind(""), "public");
  assert.equal(roomKind("K7MNP2QRS4ABCDE"), "friends");
  assert.deepEqual([roomChip("public").icon, roomChip("public").label], ["🌐", "공개방"]);
  assert.deepEqual([roomChip("friends").icon, roomChip("friends").label], ["🤝", "친구방"]);
  assert.match(roomChip("public").aria, /친구방 만들기/);
  assert.match(roomChip("friends").aria, /공개방으로/);
  for (const k of ["public", "friends"] as const) assert.ok(!/방장/.test(roomChip(k).label));
});

test("chip: lobby and result only — hidden during the 3·2·1 countdown and play", () => {
  const on = (phase: string, inResult = false) => showRoomChip({ withRoom: true, failed: false, phase, inResult });
  assert.equal(on(""), true, "before the first state = the lobby");
  assert.equal(on("lobby"), true);
  assert.equal(on("result"), true);
  assert.equal(on("countdown"), false);
  assert.equal(on("play"), false);
  assert.equal(on("play", true), true, "the shell's result view (the room may still say play)");
  assert.equal(showRoomChip({ withRoom: false, failed: false, phase: "lobby", inResult: false }), false, "a solo app has no room");
  assert.equal(showRoomChip({ withRoom: true, failed: true, phase: "lobby", inResult: false }), false, "the failed sheet holds the screen");
});

test("chip tap: public → a new friends room; friends alone → back at once; friends with others → confirm first", () => {
  assert.equal(chipAction("public", 1), "mint");
  assert.equal(chipAction("public", 5), "mint");
  assert.equal(chipAction("friends", 1), "leave");
  assert.equal(chipAction("friends", 0), "leave");
  assert.equal(chipAction("friends", 2), "confirm");
  const c = leaveFriendsCopy(true);
  assert.equal(c.title, "친구방에서 나갈까요?");
  assert.match(c.body, /2명이 모이면 바로 시작/);
  assert.ok(!/2명/.test(leaveFriendsCopy(false).body), "no auto-start claim where the public room does not start by itself");
  assert.ok(!/방장/.test(c.body));
});

test("#217 invite question: alone + no PIN + first invite in a friends room on the room server", () => {
  const base = { edge: true, code: true, connected: true, people: 1, pin: null, asked: false };
  assert.equal(askPinFirst(base), true);
  assert.equal(askPinFirst({ ...base, asked: true }), false, "asked once: later taps share");
  assert.equal(askPinFirst({ ...base, pin: "4821" }), false, "a PIN already chosen (the quiz maker)");
  assert.equal(askPinFirst({ ...base, people: 2 }), false, "a friend is in: a PIN would mean a new link");
  assert.equal(askPinFirst({ ...base, code: false }), false, "the public room hands out the maker link");
  assert.equal(askPinFirst({ ...base, edge: false }), false, "PINs need the room server");
  assert.equal(askPinFirst({ ...base, connected: false }), false);
  assert.equal(INVITE_PIN_ASK.send, "그냥 보내기");
  assert.equal(INVITE_PIN_ASK.withPin, "비밀번호 걸고 보내기");
});

test("#217 asked rooms: kept per tab; storage refused → this page still remembers", () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  const a = invitePinAsked(store);
  assert.equal(a.has("x~A"), false);
  a.add("x~A");
  assert.equal(a.has("x~A"), true);
  assert.equal(invitePinAsked(store).has("x~A"), true, "a reload in the same tab");
  const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
  const b = invitePinAsked(broken);
  b.add("y~B");
  assert.equal(b.has("y~B"), true);
  assert.equal(invitePinAsked(null).has("z"), false);
});

test("roomPin: a shell variable, handed only to templates that declare it", () => {
  assert.equal(forTemplate({ vars: {} }, "roomPin"), false);
  assert.equal(forTemplate({ vars: { roomPin: false } }, "roomPin"), true);
});

// ── the session templates, rendered ──
const DIR = new URL("../../snack-server/data/bite/", import.meta.url);
const index = JSON.parse(readFileSync(new URL("index.json", DIR), "utf8")) as { id: string; mode: string; hidden?: boolean; template?: string }[];
const SESSION = index.filter((t) => t.mode === "multi" && !t.hidden && !t.template).map((t) => t.id)
  .filter((id) => "sessionPhase" in (JSON.parse(readFileSync(new URL(`${id}.bite.json`, DIR), "utf8")).vars ?? {}));
type Box = { x: number; y: number; w: number; h: number };
type Inst = { key: string; kind?: string; content?: unknown; text?: { lines: { text: string; width: number }[]; lineHeight: number }; children: Inst[] };
function* walk(i: Inst): Generator<Inst> { yield i; for (const c of i.children) yield* walk(c); }
const ready = initLayout();
async function render(id: string, vars: Record<string, unknown>) {
  await ready;
  const doc = JSON.parse(readFileSync(new URL(`${id}.bite.json`, DIR), "utf8"));
  let t = 0;
  const app = createBite(doc, { now: () => t, random: () => 0.5, warn: () => {} });
  app.start();
  app.setVars(vars);
  for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
  const { root } = computeScene(doc, app);
  const boxes = absBoxes(root, new Map()) as Map<string, Box>;
  const out: { text: string; lines: number; width: number; box: Box }[] = [];
  for (const inst of walk(root as unknown as Inst)) {
    const lines = inst.text?.lines?.filter((l) => l.text.trim()) ?? [];
    if (!lines.length) continue;
    out.push({ text: lines.map((l) => l.text).join(""), lines: lines.length, width: Math.max(...lines.map((l) => l.width)), box: boxes.get(inst.key)! });
  }
  return { doc, out };
}

test("session templates found", () => assert.equal(SESSION.length, 10, SESSION.join(",")));
const CASES = [
  { mode: "auto", pin: false, want: "🌐 누구나 함께하는 방 · 2명 모이면 시작" },
  { mode: "host", pin: false, want: "🤝 초대받은 친구만 들어오는 방 · 방장이 시작" },
  { mode: "host", pin: true, want: "🤝🔒 초대받은 친구만 들어오는 방 · 방장이 시작" },
  { mode: "", pin: false, want: "대기실" },
];
for (const id of SESSION) {
  test(`${id}: the lobby subtitle says the room type, on one line inside the frame`, async () => {
    for (const c of CASES) {
      const { doc, out } = await render(id, { sessionPhase: "lobby", roomMode: c.mode, roomPin: c.pin, roster: ["하늘"], participants: 1 });
      assert.ok("roomPin" in doc.vars, "declares roomPin");
      const line = out.find((o) => o.text === c.want);
      assert.ok(line, `${id} ${c.mode}${c.pin ? "+pin" : ""}: "${c.want}" not on screen`);
      assert.equal(line!.lines, 1, `${id}: one line`);
      assert.ok(line!.width <= line!.box.w + 0.5 && line!.box.x >= 0 && line!.box.x + line!.width <= doc.frame[0], `${id} ${c.mode}: fits (${line!.width} in ${line!.box.w})`);
    }
  });
  test(`${id}: no "방장" anywhere in a public room (lobby / result, alone / with others)`, async () => {
    for (const mode of ["auto", ""]) {
      for (const phase of ["lobby", "result"]) {
        for (const roster of [["하늘"], ["하늘", "바다", "구름"]]) {
          const { out } = await render(id, { sessionPhase: phase, roomMode: mode, roster, participants: roster.length, hostNick: "", iAmHost: false, autoStartIn: 0 });
          const bad = out.filter((o) => /방장/.test(o.text)).map((o) => o.text);
          assert.deepEqual(bad, [], `${id} ${mode || "(no mode)"} ${phase} ${roster.length}명`);
        }
      }
    }
  });
}
