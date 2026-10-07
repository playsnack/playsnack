// Minimal WS test client for multiclient-sim.mjs. Speaks the server protocol
// (src/index.mjs): hello -> state; action{vote|tally|score} -> setVar broadcast.
// SIM_RELAY=1 → host mode: clients join through /relay and the first one runs
// the room engine (same @snack/room relayClient the player uses).
import { WebSocket } from "ws";
import { connectRelay } from "@snack/room/relay-client";

const PORT = process.env.PORT || 4399;
export const RELAY = Boolean(process.env.SIM_RELAY);
export const WS_URL = process.env.SNACK_WS || `ws://localhost:${PORT}/${RELAY ? "relay" : "ws"}`;
const PACK_URL = `http://localhost:${PORT}/api/pack`;

export class SimClient {
  constructor(slug, anonId, nick) {
    this.slug = slug; this.anonId = anonId; this.nick = nick;
    this.shared = { votesByOption: null, coopTotal: null, leaderboard: null, sessionPhase: null, raceBoard: null };
    this.participants = 0;
    this.ready = new Promise((res) => (this._onReady = res));
    const onMessage = (m) => {
      if (m.t === "state") {
        Object.assign(this.shared, m.d.sharedState || {});
        this.participants = m.d.participants ?? this.participants;
        this._onReady();
      } else if (m.t === "setVar") {
        this.shared[m.d.id] = m.d.value;
      } else if (m.t === "participants") {
        this.participants = m.d.count;
      }
    };
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
    this.ws = new WebSocket(WS_URL);
    this.ws.on("open", () => this._send("hello", { slug, anonId }));
    this.ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      onMessage(m);
    });
  }
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
  answer(option) { this._send("action", { name: "answer", payload: { option }, clientMsgId: `${this.anonId}-ans-${Math.random()}` }); }
  close() { try { this.relay ? this.relay.close() : this.ws.close(); } catch { /* */ } }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
