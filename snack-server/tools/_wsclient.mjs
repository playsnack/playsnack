// Minimal WS test client for multiclient-sim.mjs. Speaks the server protocol
// (src/index.mjs): hello -> state; action{vote|tally|score} -> setVar broadcast.
// SIM_RELAY=1 → host mode: clients join through /relay and the first one runs
// the room engine (same @snack/room relayClient the player uses).
import { WebSocket } from "ws";
import { connectRelay } from "@snack/room/relay-client";
import { connectMesh } from "@snack/room/mesh-client";
import { mqttBus } from "@snack/room/mqtt-bus";
import { wsBus } from "@snack/room/ws-bus";
import { readFileSync } from "node:fs";
import { startLocalBroker, isLocalBroker } from "../../packages/snack-room/tools/localBroker.js";
import { startEdgeHub, isLocalRelay } from "../../packages/snack-room/tools/edgeHub.js";

const PORT = process.env.PORT || 4399;
export const RELAY = Boolean(process.env.SIM_RELAY);
// SIM_MESH=1 → serverless: clients meet on an MQTT broker, no snack-server at all.
// Always a LOCAL broker (started here, lossy unless SIM_LOSSY=0) — a gate never
// touches a public broker; SIM_BROKER may point at another local one.
// SIM_EDGE=1 → serverless over the EDGE room relay (edge/room, docs/edge-relay.md) instead of
// MQTT: a local Node hub running the Worker's own core.js is started on :4550, or
// SIM_EDGE_URL points at another LOCAL relay (e.g. `wrangler dev --local` on :4551).
export const EDGE = Boolean(process.env.SIM_EDGE);
export const MESH = Boolean(process.env.SIM_MESH) || EDGE;
// SIM_EDGE_ROOM=1 → server-authoritative edge rooms: the room engine runs in the room's
// Durable Object (edge/room/src/game.js); clients speak the server /ws protocol to
// <SIM_EDGE_URL>/room/<slug>. Same hub / SIM_EDGE_URL rules as SIM_EDGE.
export const EDGE_ROOM = Boolean(process.env.SIM_EDGE_ROOM);
let localBroker = null;
let edgeHub = null;
/** The local edge hub this process started (message accounting), or null. */
export const localEdgeHub = () => edgeHub;
// What the hosting engine reported (onPoints / onActivity) — host-handover D in mesh modes.
export const engineEvents = [];
/** Mesh mode: make sure SIM_BROKER is a local broker (start one if unset). Call before any SimClient. */
export async function prepareMesh() {
  if (!MESH && !EDGE_ROOM) return null;
  if (EDGE || EDGE_ROOM) {
    if (process.env.SIM_EDGE_URL) {
      if (!isLocalRelay(process.env.SIM_EDGE_URL)) throw new Error(`SIM_EDGE_URL must be a local relay, not ${process.env.SIM_EDGE_URL}`);
      return null;
    }
    edgeHub = await startEdgeHub({ port: Number(process.env.SIM_EDGE_PORT || 4550) });
    process.env.SIM_EDGE_URL = edgeHub.url;
    return null;
  }
  if (process.env.SIM_BROKER) {
    if (!isLocalBroker(process.env.SIM_BROKER)) throw new Error(`SIM_BROKER must be a local broker, not ${process.env.SIM_BROKER}`);
    return null;
  }
  localBroker = await startLocalBroker({ lossy: process.env.SIM_LOSSY !== "0" });
  process.env.SIM_BROKER = localBroker.url;
  return localBroker;
}
export async function stopMesh() {
  await localBroker?.close();
  localBroker = null;
  await edgeHub?.close();
  edgeHub = null;
}
const staticPack = async (game) => {
  try { return JSON.parse(readFileSync(new URL(`../data/multi-content/${game}.json`, import.meta.url), "utf8")); } catch { return null; }
};
export const WS_URL = process.env.SNACK_WS || `ws://localhost:${PORT}/${RELAY ? "relay" : "ws"}`;
const PACK_URL = `http://localhost:${PORT}/api/pack`;

export class SimClient {
  constructor(slug, anonId, nick) {
    this.slug = slug; this.anonId = anonId; this.nick = nick;
    this.shared = { votesByOption: null, coopTotal: null, leaderboard: null, sessionPhase: null, raceBoard: null };
    this.participants = 0;
    this.phases = []; // every sessionPhase this client was shown, in order (evidence a session really ran)
    // Never hang a gate: give up waiting after 15s (the scenario then fails on its checks).
    this.ready = new Promise((res) => {
      this._onReady = res;
      setTimeout(() => { this.timedOut = !this.gotState; res(); }, 15000).unref();
    });
    const onMessage = (m) => {
      if (m.t === "state") {
        this.gotState = true;
        Object.assign(this.shared, m.d.sharedState || {});
        this.participants = m.d.participants ?? this.participants;
        if (m.d.sharedState?.sessionPhase) this._phase(m.d.sharedState.sessionPhase);
        this._onReady();
      } else if (m.t === "setVar") {
        this.shared[m.d.id] = m.d.value;
        if (m.d.id === "sessionPhase") this._phase(m.d.value);
      } else if (m.t === "participants") {
        this.participants = m.d.count;
      }
    };
    if (MESH) {
      const url = EDGE ? process.env.SIM_EDGE_URL : process.env.SIM_BROKER;
      if (!url || !(EDGE ? isLocalRelay(url) : isLocalBroker(url))) throw new Error(`mesh sim needs a local ${EDGE ? "relay" : "broker"} (call prepareMesh first), got ${url}`);
      this.relay = connectMesh({
        createBus: EDGE ? wsBus({ url, room: slug }) : mqttBus({ room: slug, url }),
        engine: {
          onPoints: (anonId, nick, pts) => engineEvents.push({ k: "pts", anonId, nick, pts }),
          onActivity: (kind, label) => engineEvents.push({ k: "act", kind, label }),
        },
        me: { slug, anonId, nick: this.nick ?? "" },
        onMessage,
        getPack: staticPack,
      });
      return;
    }
    if (RELAY) {
      this.relay = connectRelay({
        url: WS_URL,
        WebSocket,
        me: { slug, anonId, nick: this.nick ?? "" },
        eventsUrl: process.env.SIM_EVENTS_URL || undefined,
        onMessage,
        getPack: async (game, opts) => {
          const r = await fetch(`${PACK_URL}?${new URLSearchParams({ game: game ?? "", theme: opts?.theme ?? "" })}`).catch(() => null);
          return r?.ok ? ((await r.json()).pack ?? null) : null;
        },
      });
      return;
    }
    this.ws = new WebSocket(EDGE_ROOM ? `${process.env.SIM_EDGE_URL}/room/${encodeURIComponent(slug)}` : WS_URL);
    this.ws.on("open", () => this._send("hello", { slug, anonId, nick: this.nick ?? "" }));
    this.ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      onMessage(m);
    });
  }
  _phase(p) { if (this.phases.at(-1) !== p) this.phases.push(p); }
  /** Saw `a`, and later `b` (phases arrive in order per client). */
  sawInOrder(a, b) { const i = this.phases.indexOf(a); return i >= 0 && this.phases.indexOf(b, i + 1) > i; }
  _send(t, d) {
    if (this.relay) {
      if (t === "action") this.relay.sendAction(d.name, d.payload, d.clientMsgId);
      return;
    }
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t, d }));
  }
  vote(option) { this._send("action", { name: "vote", payload: { option }, clientMsgId: `${this.anonId}-${option}` }); }
  tally(delta = 1) { this._send("action", { name: "tally", payload: { delta }, clientMsgId: `${this.anonId}-t` }); }
  score(score) { this._send("action", { name: "score", payload: { score }, clientMsgId: `${this.anonId}-s` }); }
  start(opts = 3000) { const payload = typeof opts === "number" ? { duration: opts } : opts; this._send("action", { name: "start", payload, clientMsgId: `${this.anonId}-go` }); }
  tap() { this._send("action", { name: "tap", clientMsgId: `${this.anonId}-tap-${Math.random()}` }); }
  /** MP-08: this device's running tap total (the room keeps the max). */
  taps(count) { this._send("action", { name: "taps", payload: { count }, clientMsgId: `${this.anonId}-taps-${count}-${Math.random()}` }); }
  /** MP-08: reaction time measured on this device (green → tap, ms). */
  reaction(ms) { this._send("action", { name: "reaction", payload: { ms }, clientMsgId: `${this.anonId}-react-${Math.random()}` }); }
  /** Quiz answer; `ms` = "question shown → tap" measured on this device (omit = a legacy client). */
  answer(option, ms) { this._send("action", { name: "answer", payload: ms === undefined ? { option } : { option, ms }, clientMsgId: `${this.anonId}-ans-${Math.random()}` }); }
  /** 나 맞히기: store this player's own quiz in the room (they become its subject). */
  quizPack(payload) { this._send("action", { name: "quizPack", payload, clientMsgId: `${this.anonId}-pack-${Math.random()}` }); }
  close() { try { this.relay ? this.relay.close() : this.ws.close(); } catch { /* */ } }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
