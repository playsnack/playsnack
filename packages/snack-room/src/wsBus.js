// Pub/sub bus for serverless rooms over the edge room relay (edge/room: a Cloudflare
// Durable Object per room, or the Node hub in tests). Same interface as mqttBus:
// {ready, publish, onMessage, onStatus, close} — meshClient cannot tell them apart.
//
// One WebSocket per player at <url>/room/<room>. The first frame authenticates
// ({t:"auth", peer, pin?, token?}); the relay answers {ctl:"ok", token} and only then
// relays. The token (15 min, refreshed by the relay) lets a dropped connection come
// back without the PIN. The relay never echoes our own publishes (meshClient drops
// them anyway) and sends {from, t:"bye"} for a socket that vanished — the MQTT last will.

const FAIL_AFTER_MS = 8000; // not in for this long → give up (the player shows retry)
const RECONNECT_MS = 1000;
// Refusals that retrying the same way cannot fix.
const FINAL = new Set(["pin", "pin-required", "locked", "busy", "full", "bad"]);

/** Tokens per room, in memory (the default) — or pass sessionStorage-backed get/set. */
export const memoryTokens = () => {
  const m = new Map();
  return { get: (room) => m.get(room) ?? null, set: (room, tok) => void m.set(room, tok) };
};

/**
 * Returns a `createBus(peerId)` for connectMesh.
 * @param {{url: string, room: string, pin?: string, WebSocket?: any, failAfterMs?: number, tokens?: {get(room: string): string | null, set(room: string, tok: string): void}}} o
 */
export function wsBus({ url, room, pin, WebSocket: WS = globalThis.WebSocket, failAfterMs = FAIL_AFTER_MS, tokens = memoryTokens() }) {
  const endpoint = `${url.replace(/\/+$/, "")}/room/${encodeURIComponent(room)}`;
  return (peerId) => {
    const handlers = [];
    const statusFns = [];
    let subscribed;
    const ready = new Promise((r) => (subscribed = r));
    let ending = false;
    let failed = null;
    let ws = null;
    let authed = false;
    let downTimer = null;
    let retryTimer = null;

    const fail = (reason) => {
      if (failed || ending) return;
      failed = reason;
      ending = true;
      clearTimeout(downTimer);
      clearTimeout(retryTimer);
      try {
        ws?.close(1000);
      } catch {
        /* closed */
      }
      for (const fn of statusFns) fn({ state: "failed", reason });
    };
    const armDown = () => {
      if (ending || downTimer) return;
      downTimer = setTimeout(() => fail("timeout"), failAfterMs);
    };

    const open = () => {
      if (ending) return;
      let sock;
      try {
        sock = new WS(endpoint);
      } catch {
        return fail("url");
      }
      ws = sock;
      authed = false;
      sock.onopen = () => {
        const tok = tokens.get(room);
        sock.send(JSON.stringify({ t: "auth", peer: peerId, ...(tok ? { token: tok } : {}), ...(pin ? { pin: String(pin) } : {}) }));
      };
      sock.onmessage = (ev) => {
        if (ws !== sock) return;
        let m;
        try {
          m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if (m && typeof m.ctl === "string") {
          if (m.ctl === "ok" || m.ctl === "token") {
            if (typeof m.token === "string") tokens.set(room, m.token);
            if (m.ctl === "ok") {
              authed = true;
              clearTimeout(downTimer);
              downTimer = null;
              subscribed();
            }
          } else if (m.ctl === "denied" && FINAL.has(m.reason)) fail(m.reason === "pin-required" ? "pin" : m.reason);
          return;
        }
        if (authed && m) for (const fn of handlers) fn(m);
      };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        authed = false;
        if (ending) return;
        armDown();
        retryTimer = setTimeout(open, RECONNECT_MS);
      };
      sock.onerror = () => {}; // a close follows
    };
    armDown();
    open();

    return {
      ready,
      publish: (m) => {
        if (!ending && authed && ws && ws.readyState === 1) ws.send(JSON.stringify(m));
      },
      onMessage: (fn) => handlers.push(fn),
      onStatus: (fn) => {
        statusFns.push(fn);
        if (failed) fn({ state: "failed", reason: failed });
      },
      // Graceful end: our own "bye" is already out, so the relay sends none for us.
      close: () => {
        ending = true;
        clearTimeout(downTimer);
        clearTimeout(retryTimer);
        const sock = ws;
        ws = null;
        if (sock) setTimeout(() => sock.close(1000), 50);
      },
    };
  };
}
