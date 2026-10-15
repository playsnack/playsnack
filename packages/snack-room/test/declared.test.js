import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRoom } from "../src/room.js";

// MP-13: everything the room sends to an app must be a variable the app declared —
// otherwise the player logs "host set undeclared variable …" (and ignores it). Every
// shipped multiplayer template is driven through two whole sessions here (its own
// `start` payload, each action it emits, a leaver, a late joiner) and every variable
// the engine sent is checked against the template's `vars`.
const DIR = new URL("../../../snack-server/data/bite/", import.meta.url);
const CONTENT = new URL("../../../snack-server/data/multi-content/", import.meta.url);
const merged = new Set(
  JSON.parse(readFileSync(new URL("index.json", DIR), "utf8"))
    .filter((t) => t.mergedInto)
    .map((t) => t.id),
);
const findEmits = (doc) => {
  const out = [];
  const visit = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(visit);
    if (typeof v.emit === "string") out.push(v);
    Object.values(v).forEach(visit);
  };
  visit(doc.phases);
  visit(doc.view);
  return out;
};

async function sentVars(doc, startRule = "any") {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const sent = new Map(); // id → how it reached a player
  const note = (id, how) => sent.set(id, (sent.get(id) ?? new Set()).add(how));
  const room = createRoom({
    startRule,
    defaults: doc.vars?.votesByOption ?? {},
    now: () => t,
    random: () => 0.3,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    getPack: async (game) => {
      try {
        return JSON.parse(readFileSync(new URL(`${game}.json`, CONTENT), "utf8"));
      } catch {
        return null;
      }
    },
    broadcast: (type, d) => type === "setVar" && note(d.id, "broadcast"),
    send: (p, type, d) => {
      if (type === "setVar") note(d.id, "send");
      if (type === "state") Object.keys(d.sharedState).forEach((k) => note(k, "state"));
    },
  });
  const flush = () => new Promise((r) => setImmediate(r));
  const advance = async (ms) => {
    await flush();
    const end = t + ms;
    for (;;) {
      const n = [...timers.values()].filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!n) break;
      timers.delete(n.id);
      t = n.at;
      n.fn();
      await flush();
    }
    t = end;
    await flush();
  };
  const act = (p, name, payload) => room.action(p, { name, payload, clientMsgId: `${p}-${name}-${++seq}` });
  room.join("p1", { anonId: "a1", nick: "닉1" });
  room.join("p2", { anonId: "a2", nick: "닉2" });
  if (startRule === "auto" && doc.room) room.configureAuto(doc.room.start, doc.room.autoStartMs);
  const emits = findEmits(doc);
  const start = emits.find((e) => e.emit === "start");
  for (let session = 0; session < 2; session++) {
    // twice: the second session resets what the first one showed
    if (start) {
      act("p1", "start", start.payload);
      await advance(3000);
    }
    for (const e of emits) {
      if (e.emit === "start") continue;
      const payload = e.payload ? JSON.parse(JSON.stringify(e.payload).replace(/"\{[^}]*\}"/g, "1")) : undefined;
      act("p1", e.emit, payload);
      act("p2", e.emit, payload);
      await advance(500);
    }
    await advance(200000);
  }
  room.leave("p2");
  room.join("p3", { anonId: "a3", nick: "닉3" });
  room.destroy();
  return sent;
}

test("MP-13: the room sends only variables each shipped template declares", async () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".bite.json") && !merged.has(f.replace(".bite.json", "")));
  const bad = [];
  let checked = 0;
  for (const f of files) {
    const doc = JSON.parse(readFileSync(new URL(f, DIR), "utf8"));
    if (!findEmits(doc).length) continue; // solo app: never joins a room
    checked += 1;
    const declared = new Set(Object.keys(doc.vars ?? {}));
    const sent = await sentVars(doc);
    // friends room (방장, #135) / public room (자동 시작, #136): the session templates also get roomMode, hostNick, iAmHost
    if (doc.room) for (const rule of ["host", "auto"]) for (const [id, how] of await sentVars(doc, rule)) sent.set(id, new Set([...(sent.get(id) ?? []), ...how]));
    const undeclared = [...sent].filter(([id]) => !declared.has(id)).map(([id, how]) => `${id} (${[...how].join("/")})`);
    if (undeclared.length) bad.push(`${f}: ${undeclared.join(", ")}`);
  }
  assert.ok(checked >= 9, `checked ${checked} multiplayer templates`);
  assert.deepEqual(bad, []);
});
