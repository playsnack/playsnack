// Serverless rooms: every player joins a shared pub/sub channel (a public MQTT
// broker in the player; an in-memory bus in tests). Nobody runs a relay — the
// players agree on a host among themselves, and the host runs the room engine.
//
// Agreement: the host publishes the succession LINE (who hosts next, in order)
// and a TERM number with every heartbeat. Everyone adopts the line with the
// highest term (ties → the line whose head id sorts first). The host is line[0].
//   - newcomers are appended by the host
//   - host leaves / goes silent → the next alive player in the line takes over
//     with term+1 and the last snapshot it saw
//   - host hands off (backgrounded) → moves itself to the back, term+1
//   - a host that wakes up after a freeze sees a higher term and steps down
// Peers only accept room messages from the current host.
//
// Bus messages: {from, to?, t, ...}
//   here {anonId, nick, line?, term?}  heartbeat (host includes line/term)
//   bye                                 leaving (also the MQTT last will)
//   act {d} / react {d}                 player → host (to = host)
//   batch {items: [{to?, t, d}]}        host → everyone: room messages, ≤1 publish per
//                                       BATCH_MS (public brokers drop bursts)
//   snap {term, snap}                   host → everyone: resumable room state
//   sync                                peer → host: "I never got the room state" (resend)
//   (in a batch) resync {sharedState, participants}: host → everyone, for a few beats after
//                                       a change — a peer that lost a setVar converges anyway
import { createRoom } from "./room.js";

const rand = () => Math.random().toString(36).slice(2, 10);
const BATCH_MS = 60;

// Within one batch only the last value of a broadcast variable matters.
const coalesce = (items) => {
  const lastSet = new Map();
  items.forEach((it, i) => {
    if (!it.to && it.t === "setVar") lastSet.set(it.d.id, i);
  });
  return items.filter((it, i) => it.to || it.t !== "setVar" || lastSet.get(it.d.id) === i);
};

/**
 * @param {object} o
 * @param {(peerId: string) => {publish(m: object): void, onMessage(fn: (m: object) => void): void, close(): void, ready?: Promise<void>}} o.createBus
 *        `ready` resolves once the bus is subscribed — discovery only counts from then.
 * @param {{slug: string, anonId: string, nick: string}} o.me
 * @param {(m: {t: string, d: any}) => void} o.onMessage    room messages for this player
 * @param {(game: string, opts: object) => Promise<any[] | null>} [o.getPack]
 * @param {(isHost: boolean) => void} [o.onRole]
 * @param {{discoveryMs?: number, beatMs?: number, silenceMs?: number, snapshotMs?: number}} [o.timing]
 * @param {object} [o.engine]  extra createRoom options
 * @param {(event: string, info: object) => void} [o.debug]  diagnostics (adopt / drop / found)
 */
export function connectMesh({ createBus, me, onMessage, getPack, onRole = () => {}, timing = {}, engine: engineOpts = {}, debug = () => {} }) {
  const { discoveryMs = 1500, beatMs = 1000, silenceMs = 3500, snapshotMs = 400 } = timing;
  const myId = `${rand()}${rand()}`;
  const bus = createBus(myId);
  const peers = new Map(); // id → { anonId, nick, lastSeen }
  let line = [];
  let term = 0;
  let room = null; // engine while hosting
  let joined = new Set(); // peers joined into the engine
  let lastSnap = null; // { snap, at } — latest from the current host
  let ready = false; // discovery finished
  let closed = false;
  const outbox = []; // my actions before a host is known
  const now = () => Date.now();

  const pub = (m) => !closed && bus.publish({ from: myId, ...m });
  const host = () => line[0];
  let stateFrom = null; // the host whose room state I have
  const known = new Map(); // shared var → JSON of the value I last delivered
  let knownCount = null;
  const deliver = (t, d) => {
    if (t === "state") {
      stateFrom = host();
      known.clear();
      for (const [k, v] of Object.entries(d?.sharedState ?? {})) known.set(k, JSON.stringify(v));
      knownCount = d?.participants ?? knownCount;
    } else if (t === "setVar") known.set(d?.id, JSON.stringify(d?.value));
    else if (t === "participants") knownCount = d?.count;
    onMessage({ t, d });
  };
  // Pass on only what differs from what this player already has (no needless redraws).
  const resync = ({ sharedState = {}, participants } = {}) => {
    for (const [id, value] of Object.entries(sharedState)) {
      if (known.get(id) !== JSON.stringify(value)) deliver("setVar", { id, value });
    }
    if (typeof participants === "number" && participants !== knownCount) deliver("participants", { count: participants });
  };
  const alive = () => [...peers].filter(([, p]) => now() - p.lastSeen <= silenceMs).map(([id]) => id);

  // ── hosting ──
  let batch = [];
  let batchTimer = null;
  const flushBatch = () => {
    batchTimer = null;
    if (!batch.length) return;
    pub({ t: "batch", items: coalesce(batch.splice(0)) });
  };
  const queueRoom = (item) => {
    batch.push(item);
    batchTimer ??= setTimeout(flushBatch, BATCH_MS);
  };
  const RESYNC_BEATS = 3; // keep resyncing a few beats after the last change (it may be lost too)
  let resyncLeft = 0;
  let sentVars = {}; // latest value of every variable this host broadcast (round vars too)
  const fullState = () => ({ sharedState: { ...sentVars, ...room.sharedState() }, participants: joined.size });
  let snapTimer = null;
  const pushSnapshot = () => {
    if (snapTimer || !room) return;
    snapTimer = setTimeout(() => {
      snapTimer = null;
      if (room) pub({ t: "snap", term, snap: room.snapshot() });
    }, snapshotMs);
  };
  const syncMembers = () => {
    if (!room) return;
    const want = new Set([myId, ...alive()]);
    for (const id of want) {
      if (joined.has(id)) continue;
      joined.add(id);
      room.join(id, id === myId ? me : peers.get(id));
    }
    for (const id of [...joined]) {
      if (want.has(id)) continue;
      joined.delete(id);
      room.leave(id);
    }
  };
  const startHosting = () => {
    room = createRoom({
      ...engineOpts,
      getPack: getPack ?? (async () => null),
      broadcast: (t, d) => {
        if (t === "setVar") sentVars[d.id] = d.value;
        queueRoom({ t, d });
        deliver(t, d);
        pushSnapshot();
        resyncLeft = RESYNC_BEATS;
      },
      send: (peerId, t, d) => {
        if (peerId === myId) deliver(t, d);
        else queueRoom({ to: peerId, t, d });
      },
    });
    joined = new Set();
    sentVars = {};
    if (lastSnap) room.restore(lastSnap.snap, now() - lastSnap.at);
    tidyLine();
    beat(); // announce the line FIRST — peers drop room messages from a host they don't know yet
    syncMembers();
    pushSnapshot();
    onRole(true);
  };
  const stopHosting = () => {
    clearTimeout(batchTimer);
    batchTimer = null;
    batch = [];
    clearTimeout(snapTimer);
    snapTimer = null;
    room?.destroy();
    room = null;
    joined = new Set();
  };
  // Host-only: keep the line equal to who is actually here (order preserved).
  const tidyLine = () => {
    const here = new Set([myId, ...alive()]);
    const next = line.filter((id) => here.has(id));
    for (const id of here) if (!next.includes(id)) next.push(id);
    const changed = next.join() !== line.join();
    line = next;
    return changed;
  };
  const beat = () => pub({ t: "here", anonId: me.anonId, nick: me.nick, ...(room ? { line, term } : {}) });

  // Re-evaluate who hosts; called on every relevant change and each tick.
  const settle = () => {
    if (!ready || closed || !line.length) return;
    const h = host();
    if (h && h !== myId && !alive().includes(h)) {
      // The host left or went silent: the next alive player in the line takes over.
      const next = line.find((id) => id === myId || alive().includes(id));
      if (next === myId) {
        term += 1;
        line = [myId, ...line.filter((id) => id !== myId && id !== h)];
      } else {
        line = line.filter((id) => id !== h);
      }
    }
    if (host() === myId && !room) startHosting();
    else if (host() !== myId && room) {
      stopHosting();
      onRole(false);
    }
    if (room) {
      if (tidyLine()) beat();
      syncMembers();
    }
    if (host() && host() !== myId) for (const d of outbox.splice(0)) pub({ t: "act", to: host(), d });
  };

  const adopt = (l, t) => {
    if (!Array.isArray(l) || !l.length) return false;
    if (t > term || (t === term && l[0] < (line[0] ?? "~"))) {
      line = l.slice();
      term = t;
      debug("adopt", { line, term });
      return true;
    }
    return false;
  };

  bus.onMessage((m) => {
    if (!m || m.from === myId || closed) return;
    const from = m.from;
    if (m.t === "bye") {
      peers.delete(from);
      if (from === host()) {
        // Act now instead of waiting for silence.
        settle();
      } else if (room) settle();
      return;
    }
    const p = peers.get(from) ?? { anonId: "", nick: "" };
    p.lastSeen = now();
    if (m.t === "here") {
      p.anonId = String(m.anonId ?? p.anonId);
      p.nick = String(m.nick ?? p.nick);
    }
    const isNew = !peers.has(from);
    peers.set(from, p);
    if (m.t === "here") {
      if (m.line && adopt(m.line, m.term)) settle();
      else if (isNew) {
        if (room) settle(); // host: append + join the newcomer
        if (!ready) return;
      }
      if (isNew && ready) beat(); // let the newcomer learn about me quickly
      return;
    }
    if (m.t === "snap") {
      if (from === host() && m.term >= term) lastSnap = { snap: m.snap, at: now() };
      return;
    }
    if (m.t === "batch") {
      if (from !== host()) {
        debug("drop", { why: "not-host", from, host: host(), n: m.items?.length, line, term });
        return; // stale host (e.g. waking from a freeze)
      }
      for (const it of m.items ?? []) {
        if (it.to && it.to !== myId) continue;
        if (it.t === "resync") {
          if (stateFrom === host()) resync(it.d);
        } else deliver(it.t, it.d);
      }
      return;
    }
    if (m.t === "sync" && room && m.to === myId) {
      if (!joined.has(from)) syncMembers();
      else queueRoom({ to: from, t: "state", d: fullState() });
      return;
    }
    if ((m.t === "act" || m.t === "react") && room && m.to === myId) {
      if (!joined.has(from)) syncMembers();
      if (m.t === "react") room.react(m.d?.emoji);
      else room.action(from, m.d);
    }
  });

  // Discovery: say hello, listen for a host; if nobody answers, host alone.
  // Players who arrive together all see each other here (none has a line yet):
  // only the smallest id founds the room; the rest wait for its line. The clock
  // starts once the bus is subscribed (a broker connection alone can take ~1.5s).
  let discovery = null;
  Promise.resolve(bus.ready).then(() => {
    if (closed) return;
    beat();
    discovery = setTimeout(() => {
      ready = true;
      if (!line.length) {
        const founders = [myId, ...alive()].sort();
        if (founders[0] === myId) {
          line = founders;
          term = Math.max(term, 1);
          debug("found", { line });
        }
      }
      settle();
      if (host() !== myId) onRole(false);
      beat();
    }, discoveryMs);
  });
  const tick = setInterval(() => {
    if (ready && !line.length) {
      // Still no host (the founder we waited for never announced): found it ourselves.
      const founders = [myId, ...alive()].sort();
      if (founders[0] === myId || !alive().includes(founders[0])) {
        line = [myId, ...alive()];
        term = Math.max(term, 1);
      }
    }
    beat();
    settle();
    if (room) {
      pushSnapshot();
      if (resyncLeft > 0) {
        resyncLeft -= 1;
        queueRoom({ t: "resync", d: fullState() });
      }
    }
    // A lost "state" (public brokers drop messages under load): ask the host again.
    else if (ready && host() && stateFrom !== host()) pub({ t: "sync", to: host() });
  }, beatMs);

  return {
    get isHost() {
      return Boolean(room);
    },
    get peerId() {
      return myId;
    },
    sendAction(name, payload, clientMsgId) {
      const d = { name, payload, clientMsgId };
      if (room) room.action(myId, d);
      else if (host() && ready) pub({ t: "act", to: host(), d });
      else outbox.push(d);
    },
    sendReaction(emoji) {
      if (room) room.react(emoji);
      else if (host()) pub({ t: "react", to: host(), d: { emoji } });
    },
    /** Hosting from a device about to sleep? Move to the back of the line. */
    handoff() {
      if (!room || alive().length === 0) return;
      pub({ t: "snap", term, snap: room.snapshot() });
      term += 1;
      line = [...line.filter((id) => id !== myId && alive().includes(id)), myId];
      beatAs(line, term);
      stopHosting();
      onRole(false);
    },
    close() {
      if (closed) return;
      pub({ t: "bye" });
      closed = true;
      clearTimeout(discovery);
      clearInterval(tick);
      stopHosting();
      bus.close();
    },
  };

  // A handing-off host announces the new line once more (it no longer hosts).
  function beatAs(l, t) {
    pub({ t: "here", anonId: me.anonId, nick: me.nick, line: l, term: t });
  }
}
