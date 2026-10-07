// Minimal WS test client for multiclient-sim.mjs. Speaks the server protocol
// (src/index.mjs): hello -> state; action{vote|tally|score} -> setVar broadcast.
import { WebSocket } from "ws";

export const WS_URL = process.env.SNACK_WS || `ws://localhost:${process.env.PORT || 4399}/ws`;

export class SimClient {
  constructor(slug, anonId) {
    this.slug = slug; this.anonId = anonId;
    this.shared = { votesByOption: null, coopTotal: null, leaderboard: null, sessionPhase: null, raceBoard: null };
    this.participants = 0;
    this.ready = new Promise((res) => (this._onReady = res));
    this.ws = new WebSocket(WS_URL);
    this.ws.on("open", () => this._send("hello", { slug, anonId }));
    this.ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.t === "state") {
        Object.assign(this.shared, m.d.sharedState || {});
        this.participants = m.d.participants ?? this.participants;
        this._onReady();
      } else if (m.t === "setVar") {
        this.shared[m.d.id] = m.d.value;
      } else if (m.t === "participants") {
        this.participants = m.d.count;
      }
    });
  }
  _send(t, d) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t, d })); }
  vote(option) { this._send("action", { name: "vote", payload: { option }, clientMsgId: `${this.anonId}-${option}` }); }
  tally(delta = 1) { this._send("action", { name: "tally", payload: { delta }, clientMsgId: `${this.anonId}-t` }); }
  score(score) { this._send("action", { name: "score", payload: { score }, clientMsgId: `${this.anonId}-s` }); }
  start(opts = 3000) { const payload = typeof opts === "number" ? { duration: opts } : opts; this._send("action", { name: "start", payload, clientMsgId: `${this.anonId}-go` }); }
  tap() { this._send("action", { name: "tap", clientMsgId: `${this.anonId}-tap-${Math.random()}` }); }
  answer(option) { this._send("action", { name: "answer", payload: { option }, clientMsgId: `${this.anonId}-ans-${Math.random()}` }); }
  close() { try { this.ws.close(); } catch { /* */ } }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
