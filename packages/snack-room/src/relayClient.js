// Host mode: join a room through the thin relay. The first player in a room is
// the HOST and runs the room engine on their own device; everyone else (and the
// host itself) receives the engine's messages exactly as if a server sent them.
// Environment-agnostic — pass the WebSocket class (browser global or `ws`), so
// the player and the multiplayer simulator share this code.
//
// Relay protocol (see snack-server/src/relay.mjs):
//   → hello {slug, anonId, nick}            ← welcome {peerId, hostId}
//   → action|react {…}   (peers)            ← to host: from {peerId, kind, d}
//   ← to host: peer-join {peerId, anonId, nick} · peer-leave {peerId}
//   ← become-host {peers, snapshot, age}   (the old host left / stalled / handed off)
//   ← demote {}                            (you were the host; someone else is now)
//   → broadcast {t, d} · send {peerId, t, d} (host) ← plain {t, d} to peers
//   → snapshot {snap} · beat · handoff     (host: resumable state, liveness, hand over)
import { createRoom } from "./room.js";
import { localCountdown, countdownState } from "./countdown.js";

const BEAT_MS = 1000; // host heartbeat (the relay hands over after 3s of silence)
const SNAPSHOT_DEBOUNCE_MS = 200;
const EVENTS_FLUSH_MS = 2000;

/**
 * @param {object} o
 * @param {string} o.url                 relay WebSocket URL
 * @param {typeof WebSocket} o.WebSocket
 * @param {{slug: string, anonId: string, nick: string}} o.me
 * @param {(m: {t: string, d: any}) => void} o.onMessage   room messages for this player
 * @param {(game: string, opts: object) => Promise<any[] | null>} [o.getPack]
 * @param {(isHost: boolean) => void} [o.onRole]
 * @param {string} [o.eventsUrl]         while hosting, POST player points / activity here
 * @param {object} [o.engine]            extra createRoom options (clock, timers, hooks)
 */
export function connectRelay({ url, WebSocket, me, onMessage, getPack, onRole = () => {}, eventsUrl, engine: engineOpts = {} }) {
  const ws = new WebSocket(url);
  let myId = null;
  let room = null; // the engine, only while this player is the host
  let closed = false;
  const queue = [];

  const raw = (t, d) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t, d }));
    else queue.push({ t, d });
  };
  // The 3·2·1 runs on this device's clock (countdown.js); the host's numbers refine it.
  const cd = localCountdown({ deliver: (t, d) => onMessage({ t, d }) });
  const deliver = (t, d) => {
    if (t === "countdown") return cd.start(d ?? {});
    if (t === "setVar" && d?.id === "sessionCountdown" && cd.intercept(d.value)) return;
    if (t === "state") d = countdownState(d, cd);
    onMessage({ t, d });
  };

  // While hosting: push a snapshot shortly after every change and beat steadily,
  // so the relay can resume the room elsewhere if this device goes away.
  let beat = null;
  let snapTimer = null;
  const pushSnapshot = () => {
    if (snapTimer || !room) return;
    snapTimer = setTimeout(() => {
      snapTimer = null;
      if (room) raw("snapshot", { snap: room.snapshot() });
    }, SNAPSHOT_DEBOUNCE_MS);
  };
  // Global stats (player points, activity) still live on the server: the host
  // batches what its engine reports and posts it.
  let events = [];
  let flushTimer = null;
  const flushEvents = () => {
    flushTimer = null;
    if (!eventsUrl || !events.length) return;
    const batch = events.splice(0, 50);
    fetch(eventsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: me.slug, events: batch }), keepalive: true }).catch(() => {});
    if (events.length) flushTimer = setTimeout(flushEvents, EVENTS_FLUSH_MS);
  };
  const queueEvent = (e) => {
    if (!eventsUrl) return;
    events.push(e);
    flushTimer ??= setTimeout(flushEvents, EVENTS_FLUSH_MS);
  };
  const stopHosting = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushEvents(); // don't drop what this host already counted
    }
    clearInterval(beat);
    clearTimeout(snapTimer);
    beat = snapTimer = null;
    room?.destroy();
    room = null;
  };

  const becomeHost = (peers, snapshot, age) => {
    stopHosting();
    room = createRoom({
      ...engineOpts,
      getPack: getPack ?? (async () => null),
      onPoints: (anonId, nick, pts) => queueEvent({ k: "pts", anonId, nick, pts }),
      onActivity: (kind, label) => queueEvent({ k: "act", kind, label }),
      broadcast: (t, d) => {
        raw("broadcast", { t, d });
        deliver(t, d);
        pushSnapshot();
      },
      send: (peerId, t, d) => {
        if (peerId === myId) deliver(t, d);
        else raw("send", { peerId, t, d });
      },
    });
    if (snapshot) room.restore(snapshot, age ?? 0);
    room.join(myId, me);
    for (const p of peers) if (p.peerId !== myId) room.join(p.peerId, p);
    beat = setInterval(() => raw("beat", {}), BEAT_MS);
    pushSnapshot();
    onRole(true);
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: "hello", d: me }));
    for (const m of queue.splice(0)) ws.send(JSON.stringify(m));
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch {
      return;
    }
    const { t, d } = m;
    if (t === "welcome") {
      myId = d.peerId;
      if (d.hostId === myId) becomeHost([]);
      else onRole(false);
    } else if (t === "become-host") {
      becomeHost(d.peers ?? [], d.snapshot, d.age);
    } else if (t === "demote") {
      stopHosting();
      onRole(false);
    } else if (t === "peer-join") {
      room?.join(d.peerId, d);
    } else if (t === "peer-leave") {
      room?.leave(d.peerId);
    } else if (t === "from") {
      if (!room) return;
      if (d.kind === "react") return room.react(d.d?.emoji);
      room.action(d.peerId, d.d);
      pushSnapshot(); // even a change that shows nothing yet (a hidden vote) must survive a hand-over
    } else {
      deliver(t, d); // a room message relayed from the host
    }
  };
  ws.onclose = () => {
    cd.stop();
    stopHosting();
    if (!closed) deliver("disconnected", {});
  };

  return {
    get isHost() {
      return Boolean(room);
    },
    sendAction(name, payload, clientMsgId) {
      const d = { name, payload, clientMsgId };
      if (room) {
        room.action(myId, d);
        pushSnapshot();
      } else raw("action", d);
    },
    sendReaction(emoji) {
      if (room) room.react(emoji);
      else raw("react", { emoji });
    },
    /** Hosting from a device that is about to sleep? Hand the room to someone else. */
    handoff() {
      if (room) raw("handoff", {});
    },
    close() {
      closed = true;
      cd.stop();
      stopHosting();
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
