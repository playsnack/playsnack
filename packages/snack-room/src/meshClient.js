// Serverless rooms: every player joins a shared pub/sub channel (an MQTT broker
// in the player; an in-memory bus in tests). Nobody runs a relay — the players
// agree on a host among themselves, and the host runs the room engine.
//
// Agreement: the host publishes the succession LINE (who hosts next, in order)
// and a TERM number with every heartbeat. Everyone adopts the line with the
// highest term (ties → the line whose head id sorts first). The host is line[0].
//   - newcomers are appended by the host
//   - host leaves / goes silent → the next alive player in the line takes over
//     with term+1 and the last snapshot it saw
//   - host hands off (backgrounded) → moves itself to the back, term+1, and keeps
//     announcing that line (with the snapshot) until the next host is heard
//   - a host that wakes up after a freeze sees a higher term and steps down
//   - a host whose heartbeats stop carrying a line (it stopped hosting, and its
//     new line never arrived) is replaced like a silent one
// Peers only accept room messages from the current host.
//
// Bus messages: {from, to?, t, ...}
//   here {anonId, nick, ack, line?, term?, snap?, seen?}
//                                       heartbeat (host includes line/term; a handing-off
//                                       host adds the snapshot; ack:1 = "I acknowledge actions")
//   bye                                 leaving (also the MQTT last will)
//   act {d, mid} / react {d}            player → host (to = host); acts are resent
//                                       until the host acks `mid` (it de-dupes)
//   batch {seq, items: [{to?, t, d}]}   host → everyone: room messages, ≤1 publish per
//                                       BATCH_MS (public brokers drop bursts). `seq`
//                                       rises per batch: an older batch arriving late
//                                       never rolls a variable back.
//   snap {term, n, snap, seen}          host → everyone: resumable room state, only when it
//                                       changed (and every few seconds regardless, in case
//                                       one was lost); `n` rises per snapshot — an older
//                                       one arriving late is ignored
//   sync                                peer → host: "I never got the room state" (resend)
//   (in a batch) mack {mid}             host → one peer: action received
//   (in a batch) resync {sharedState, participants, mine}: host → everyone, for a few
//                                       beats after a change (shared + each player's own
//                                       values) — a peer that lost a setVar converges anyway
//   (in a batch) countdown {n, stepMs, endsIn}: host → everyone, "play starts in endsIn ms";
//                                       each peer counts 3·2·1 down on its own clock
import { createRoom } from "./room.js";
import { localCountdown, countdownState } from "./countdown.js";

const rand = () => Math.random().toString(36).slice(2, 10);
const BATCH_MS = 60;
const REPLAY_MAX_AGE_MS = 5000; // a queued action older than this is stale (e.g. a "start")
const PENDING_MAX_AGE_MS = 10000; // stop resending an unacknowledged action after this
// Action ids a host remembers for de-duplication: a resend arrives within PENDING_MAX_AGE_MS,
// so ids older than that are useless — only the recent ones ride in a snapshot.
const SEEN_MAX = 2000;
const SEEN_MAX_AGE_MS = PENDING_MAX_AGE_MS + 5000;
const SNAP_REFRESH_MS = 5000; // an unchanged snapshot is republished this often (a lost one is repaired)

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
 * @param {(peerId: string) => {publish(m: object): void, onMessage(fn: (m: object) => void): void, close(): void, ready?: Promise<void>, onStatus?(fn: (s: {state: string, reason?: string}) => void): void}} o.createBus
 *        `ready` resolves once the bus is subscribed — discovery only counts from then.
 *        `onStatus` reports a bus that gave up ({state: "failed", reason}).
 * @param {{slug: string, anonId: string, nick: string}} o.me
 * @param {(m: {t: string, d: any}) => void} o.onMessage    room messages for this player
 * @param {(game: string, opts: object) => Promise<any[] | null>} [o.getPack]
 * @param {(isHost: boolean) => void} [o.onRole]
 * @param {(s: {state: "connecting" | "connected" | "failed", reason?: string}) => void} [o.onStatus]
 *        "connecting" at once, "connected" when the room state arrives, "failed" when the bus gives up.
 * @param {{discoveryMs?: number, beatMs?: number, silenceMs?: number, snapshotMs?: number, resendMs?: number}} [o.timing]
 * @param {object} [o.engine]  extra createRoom options
 * @param {(event: string, info: object) => void} [o.debug]  diagnostics (adopt / drop / found)
 */
export function connectMesh({ createBus, me, onMessage, getPack, onRole = () => {}, onStatus = () => {}, timing = {}, engine: engineOpts = {}, debug = () => {} }) {
  const { discoveryMs = 1500, beatMs = 1000, silenceMs = 3500, snapshotMs = 400, resendMs = 700 } = timing;
  const myId = `${rand()}${rand()}`;
  const peers = new Map(); // id → { anonId, nick, lastSeen, acks, idle, hosted }
  let line = [];
  let term = 0;
  let room = null; // engine while hosting
  let joined = new Set(); // peers joined into the engine
  let lastSnap = null; // { snap, seen, at, from?, n? } — latest from the current host
  let handedOff = null; // { line, term, snap, seen, at } — my hand-off, announced until the next host is heard
  let ready = false; // discovery finished
  let closed = false;
  const outbox = []; // { d, mid, at } — my actions before a host is known
  const pending = new Map(); // mid → { d, at, sent } — sent to a remote host, not yet acked
  // mid → { d, at } — acked by a host recently. A new host resumes from a snapshot that may
  // predate the ack (MP-06): these go out again and its `seen` list de-duplicates them.
  const acked = new Map();
  const now = () => Date.now();

  let status = "";
  const setStatus = (state, reason) => {
    if (status === state || status === "failed") return;
    status = state;
    onStatus(reason ? { state, reason } : { state });
  };
  setStatus("connecting");
  const bus = createBus(myId);

  const pub = (m) => !closed && bus.publish({ from: myId, ...m });
  const host = () => line[0];
  const hostAcks = () => Boolean(peers.get(host())?.acks);

  // ── what this player has been shown (peer side) ──
  let stateFrom = null; // the host whose room state I have
  let seqFrom = null; // the host the per-variable sequence numbers below belong to
  const varSeq = new Map(); // var id (or "#participants") → batch seq of the value shown
  const known = new Map(); // var → JSON of the value I last delivered
  let knownCount = null;
  const fresh = (key, seq) => seq === undefined || seq >= (varSeq.get(key) ?? -Infinity);
  const mark = (key, seq) => seq !== undefined && varSeq.set(key, seq);
  const pass = (t, d) => {
    if (t === "state") {
      stateFrom = host();
      for (const [k, v] of Object.entries(d?.sharedState ?? {})) known.set(k, JSON.stringify(v));
      if (typeof d?.participants === "number") knownCount = d.participants;
      setStatus("connected");
    } else if (t === "setVar") known.set(d?.id, JSON.stringify(d?.value));
    else if (t === "participants") knownCount = d?.count;
    onMessage({ t, d });
  };
  // The 3·2·1 runs on this device's clock (countdown.js); the host's numbers refine it.
  const cd = localCountdown({ deliver: pass });
  const deliver = (t, d) => {
    if (t === "countdown") return cd.start(d ?? {});
    if (t === "setVar" && d?.id === "sessionCountdown" && cd.intercept(d.value)) return;
    if (t === "state") d = countdownState(d, cd);
    pass(t, d);
  };
  // A room message from the host, inside batch `seq`: skip anything older than what is shown.
  const receive = (t, d, seq) => {
    if (t === "state") {
      const sharedState = {};
      for (const [k, v] of Object.entries(d?.sharedState ?? {})) {
        if (!fresh(k, seq)) continue;
        mark(k, seq);
        sharedState[k] = v;
      }
      const out = { ...d, sharedState };
      if (!fresh("#participants", seq)) delete out.participants;
      else mark("#participants", seq);
      return deliver("state", out);
    }
    if (t === "setVar") {
      if (!fresh(d?.id, seq)) return;
      mark(d?.id, seq);
    } else if (t === "participants") {
      if (!fresh("#participants", seq)) return;
      mark("#participants", seq);
    }
    deliver(t, d);
  };
  // Pass on only what differs from what this player already has (no needless redraws).
  const resync = ({ sharedState = {}, participants, mine = {} } = {}, seq) => {
    for (const [id, value] of Object.entries({ ...sharedState, ...(mine[myId] ?? {}) })) {
      if (!fresh(id, seq)) continue;
      mark(id, seq);
      if (known.get(id) !== JSON.stringify(value)) deliver("setVar", { id, value });
    }
    if (typeof participants === "number" && fresh("#participants", seq)) {
      mark("#participants", seq);
      if (participants !== knownCount) deliver("participants", { count: participants });
    }
  };
  const alive = () => [...peers].filter(([, p]) => now() - p.lastSeen <= silenceMs).map(([id]) => id);

  // ── hosting ──
  let batch = [];
  let batchTimer = null;
  let batchSeq = 0;
  const flushBatch = () => {
    batchTimer = null;
    if (!batch.length) return;
    pub({ t: "batch", seq: ++batchSeq, items: coalesce(batch.splice(0)) });
  };
  const queueRoom = (item) => {
    batch.push(item);
    batchTimer ??= setTimeout(flushBatch, BATCH_MS);
  };
  const RESYNC_BEATS = 3; // keep resyncing a few beats after the last change (it may be lost too)
  let resyncLeft = 0;
  // Action ids this room already applied (carried in snapshots, so a resend after a
  // host change is not counted twice).
  let seen = new Map(); // mid → when it was applied
  let seenN = 0; // ids remembered so far (forgetting old ones is not a change)
  const remember = (mid) => {
    seen.set(mid, now());
    seenN += 1;
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  };
  // The ids a next host still needs (recent enough to be resent) — older ones are forgotten.
  const recentSeen = () => {
    const cutoff = now() - SEEN_MAX_AGE_MS;
    for (const [mid, at] of seen) {
      if (at > cutoff) break; // insertion order = time order
      seen.delete(mid);
    }
    return [...seen.keys()];
  };
  const resyncState = () => {
    const mine = {};
    for (const id of joined) {
      const own = room.playerVars(id);
      if (Object.keys(own).length) mine[id] = own;
    }
    return { sharedState: room.sharedState(), participants: joined.size, mine };
  };
  let snapTimer = null;
  let snapN = 0;
  let snapKey = null; // what the last published snapshot contained (time-relative fields aside)
  let snapAt = 0;
  // Times in a snapshot are relative to when it was taken (and a peer restores it by its
  // age), so a snapshot whose only change is time passing says nothing new.
  const TIME_KEYS = new Set(["remaining", "roundStartAgo", "goAtAgo", "playAtAgo", "lateLeft"]);
  const timeless = (k, v) => (TIME_KEYS.has(k) ? 0 : v);
  const pushSnapshot = () => {
    if (snapTimer || !room) return;
    snapTimer = setTimeout(() => {
      snapTimer = null;
      if (!room) return;
      const snap = room.snapshot();
      const key = JSON.stringify([snap, seenN], timeless);
      if (key === snapKey && now() - snapAt < SNAP_REFRESH_MS) return;
      snapKey = key;
      snapAt = now();
      pub({ t: "snap", term, n: ++snapN, snap, seen: recentSeen() });
    }, snapshotMs);
  };
  // A peer joins the engine only once its heartbeat told us who it is.
  const syncMembers = () => {
    if (!room) return;
    const want = new Set([myId, ...alive().filter((id) => peers.get(id)?.anonId)]);
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
        queueRoom({ t, d });
        deliver(t, d);
        pushSnapshot();
        resyncLeft = RESYNC_BEATS;
      },
      send: (peerId, t, d) => {
        if (peerId === myId) deliver(t, d);
        else queueRoom({ to: peerId, t, d });
        if (t === "setVar") {
          pushSnapshot();
          resyncLeft = RESYNC_BEATS;
        }
      },
    });
    joined = new Set();
    handedOff = null;
    seen = new Map((lastSnap?.seen ?? []).map((mid) => [mid, now()]));
    snapKey = null;
    const takeover = Boolean(lastSnap);
    if (lastSnap) room.restore(lastSnap.snap, now() - lastSnap.at);
    tidyLine();
    beat(); // announce the line FIRST — peers drop room messages from a host they don't know yet
    syncMembers(); // every member gets the full state ("state") from the new engine
    if (takeover) resyncLeft = RESYNC_BEATS; // …and again for a few beats: a peer may adopt the line late
    pushSnapshot();
    // My own actions that were waiting for a host (or for an ack from the old one, or
    // acked after its last snapshot) happen here now — unless they are stale or the old
    // host already applied them.
    const mine = [...outbox.splice(0), ...[...pending, ...acked].map(([mid, p]) => ({ mid, ...p }))].sort((a, b) => a.at - b.at);
    pending.clear();
    acked.clear();
    for (const x of mine) {
      if (now() - x.at > REPLAY_MAX_AGE_MS || seen.has(x.mid)) continue;
      remember(x.mid);
      room.action(myId, x.d);
    }
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
  // A handing-off host repeats the new line (with the snapshot — the next host can't get
  // one without the other) on every beat until the next host is heard: a single lost
  // announcement must not leave the room without a host.
  const announce = () => (room ? { line, term } : handedOff ? { line: handedOff.line, term: handedOff.term, snap: handedOff.snap, seen: handedOff.seen } : {});
  const beat = () => pub({ t: "here", anonId: me.anonId, nick: me.nick, ack: 1, ...announce() });
  // A peer that was seen hosting, whose heartbeats stopped carrying a line: it no longer
  // hosts. Two in a row, so a pre-hosting heartbeat delivered late (reordering) never
  // triggers a takeover. A hand-off target that has not announced yet is not "quit".
  const quit = (id) => Boolean(peers.get(id)?.hosted) && peers.get(id).idle >= 2;
  let watched = null; // the host whose heartbeats are being watched for a line

  // ── my actions → the host ──
  const sendAct = (mid, d, at) => {
    pub({ t: "act", to: host(), d, mid });
    if (hostAcks()) pending.set(mid, { d, at, sent: now() });
  };
  const resendPending = (all = false) => {
    if (room || !host() || !ready) return;
    for (const [mid, p] of pending) {
      if (now() - p.at > PENDING_MAX_AGE_MS) pending.delete(mid);
      else if (all || now() - p.sent >= resendMs) {
        p.sent = now();
        pub({ t: "act", to: host(), d: p.d, mid });
      }
    }
  };
  const forgetOldAcked = () => {
    const cutoff = now() - SEEN_MAX_AGE_MS;
    for (const [mid, p] of acked) if (p.at < cutoff) acked.delete(mid);
  };
  // A new host: what the old one acked may not be in the snapshot it resumed from —
  // send it again (its `seen` list drops what was already counted).
  const replayAcked = () => {
    forgetOldAcked();
    for (const [mid, p] of acked) pending.set(mid, { d: p.d, at: p.at, sent: 0 });
    acked.clear();
  };
  let ackedHost = null; // the host my pending actions were last (re)sent to

  // Re-evaluate who hosts; called on every relevant change and each tick.
  const settle = () => {
    if (!ready || closed || !line.length) return;
    const h = host();
    if (h !== watched) {
      watched = h;
      const p = peers.get(h);
      if (p) p.idle = 0; // only heartbeats from now on count
    }
    if (h && h !== myId && (!alive().includes(h) || quit(h))) {
      // The host left, went silent or stopped hosting: the next alive player in the line takes over.
      const next = line.find((id) => id !== h && (id === myId || alive().includes(id)));
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
    if (host() && host() !== myId) {
      for (const x of outbox.splice(0)) if (now() - x.at <= REPLAY_MAX_AGE_MS) sendAct(x.mid, x.d, x.at);
      if (ackedHost !== host()) {
        ackedHost = host();
        replayAcked();
        resendPending(true); // a new host: it may never have seen them
      }
    }
  };

  const adopt = (l, t) => {
    if (!Array.isArray(l) || !l.length) return false;
    if (t > term || (t === term && l[0] < (line[0] ?? "~"))) {
      line = l.slice();
      term = t;
      handedOff = null; // superseded
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
      if (from === host() || room) settle(); // act now instead of waiting for silence
      return;
    }
    const p = peers.get(from) ?? { anonId: "", nick: "", acks: false };
    p.lastSeen = now();
    if (m.t === "here") {
      p.anonId = String(m.anonId ?? p.anonId);
      p.nick = String(m.nick ?? p.nick);
      p.acks = Boolean(m.ack);
      p.idle = m.line ? 0 : (p.idle ?? 0) + 1; // heartbeats in a row without a line
      if (m.line?.[0] === from) p.hosted = true; // announces itself as host
    }
    const isNew = !peers.has(from);
    peers.set(from, p);
    if (m.t === "here") {
      if (handedOff && m.line?.[0] === from && m.term >= handedOff.term) handedOff = null; // the next host is up
      if (m.line && adopt(m.line, m.term)) {
        if (m.snap) lastSnap = { snap: m.snap, seen: m.seen, at: now() }; // a hand-off
        if (!ready) return finishDiscovery(); // a host answered: no need to wait out discovery
        settle();
      } else if (isNew) {
        if (room) settle(); // host: append + join the newcomer
        if (!ready) return;
      } else if (room && !joined.has(from)) settle(); // first heartbeat after an early act
      else if (from === host() && quit(from)) settle(); // the host no longer hosts: take over now
      if (isNew && ready) beat(); // let the newcomer learn about me quickly
      return;
    }
    if (m.t === "snap") {
      if (from !== host() || m.term < term) return;
      if (lastSnap?.from === from && lastSnap.n !== undefined && !(m.n > lastSnap.n)) return; // older, arriving late
      lastSnap = { snap: m.snap, seen: m.seen, at: now(), from, n: m.n };
      return;
    }
    if (m.t === "batch") {
      if (from !== host()) {
        debug("drop", { why: "not-host", from, host: host(), n: m.items?.length, line, term });
        return; // stale host (e.g. waking from a freeze)
      }
      if (seqFrom !== from) {
        seqFrom = from;
        varSeq.clear();
      }
      for (const it of m.items ?? []) {
        if (it.to && it.to !== myId) continue;
        if (it.t === "mack") {
          const p = pending.get(it.d?.mid);
          if (p) {
            pending.delete(it.d.mid);
            acked.set(it.d.mid, { d: p.d, at: p.at });
            if (acked.size > SEEN_MAX) acked.delete(acked.keys().next().value);
          }
        } else if (it.t === "resync") {
          if (stateFrom === host()) resync(it.d, m.seq);
        } else receive(it.t, it.d, m.seq);
      }
      return;
    }
    if (m.t === "sync" && room && m.to === myId) {
      if (!joined.has(from)) syncMembers();
      else queueRoom({ to: from, t: "state", d: room.stateFor(from) });
      return;
    }
    if ((m.t === "act" || m.t === "react") && room && m.to === myId) {
      if (!joined.has(from)) syncMembers();
      if (!joined.has(from)) return; // not introduced yet (its heartbeat was lost): it resends
      if (m.t === "react") return room.react(m.d?.emoji);
      if (m.mid) {
        queueRoom({ to: from, t: "mack", d: { mid: m.mid } });
        if (seen.has(m.mid)) return; // a resend of something already counted
        remember(m.mid);
      }
      room.action(from, m.d);
      pushSnapshot(); // even a change that shows nothing yet (a hidden vote) must survive a hand-over
    }
  });

  // Discovery: say hello, listen for a host; if nobody answers, host alone.
  // Players who arrive together all see each other here (none has a line yet):
  // only the smallest id founds the room; the rest wait for its line. The clock
  // starts once the bus is subscribed (a broker connection alone can take ~1.5s).
  // A host's heartbeat ends discovery at once.
  let discovery = null;
  const finishDiscovery = () => {
    if (ready || closed) return;
    clearTimeout(discovery);
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
  };
  Promise.resolve(bus.ready).then(() => {
    if (closed || ready) return;
    beat();
    discovery = setTimeout(finishDiscovery, discoveryMs);
  });
  bus.onStatus?.((s) => {
    if (s?.state !== "failed" || closed) return;
    setStatus("failed", s.reason || "broker");
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
    if (handedOff && now() - handedOff.at > silenceMs) handedOff = null; // said it enough; silence rules now
    beat();
    settle();
    if (room) {
      pushSnapshot();
      if (resyncLeft > 0) {
        resyncLeft -= 1;
        queueRoom({ t: "resync", d: resyncState() });
      }
    }
    // A lost "state" (public brokers drop messages under load): ask the host again.
    else if (ready && host() && stateFrom !== host()) pub({ t: "sync", to: host() });
  }, beatMs);
  // Unacknowledged actions go out again (a broker may drop them).
  const resendTick = setInterval(() => {
    resendPending();
    forgetOldAcked();
  }, Math.max(20, Math.floor(resendMs / 3)));

  return {
    get isHost() {
      return Boolean(room);
    },
    get peerId() {
      return myId;
    },
    sendAction(name, payload, clientMsgId) {
      const d = { name, payload, clientMsgId };
      const mid = `${rand()}${rand()}`;
      if (room) {
        remember(mid);
        room.action(myId, d);
        pushSnapshot();
      } else if (host() && ready) sendAct(mid, d, now());
      else outbox.push({ d, mid, at: now() });
    },
    sendReaction(emoji) {
      if (room) room.react(emoji);
      else if (host()) pub({ t: "react", to: host(), d: { emoji } });
    },
    /** Hosting from a device about to sleep? Move to the back of the line. */
    handoff() {
      if (!room || alive().length === 0) return;
      flushBatch();
      term += 1;
      line = [...line.filter((id) => id !== myId && alive().includes(id)), myId];
      handedOff = { line: line.slice(), term, snap: room.snapshot(), seen: recentSeen(), at: now() };
      stopHosting();
      beat(); // the new line + snapshot, repeated on every beat until the next host is heard
      onRole(false);
    },
    close() {
      if (closed) return;
      pub({ t: "bye" });
      closed = true;
      clearTimeout(discovery);
      clearInterval(tick);
      clearInterval(resendTick);
      cd.stop();
      stopHosting();
      bus.close();
    },
  };
}
