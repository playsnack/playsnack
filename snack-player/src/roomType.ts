// Which room this is (#143): a public room (/p/<slug>: anyone, starts by itself once 2 are in on
// the room server) or a friends room (/p/<slug>?room=<code>: invited only, the host starts, an
// optional PIN). One top-row chip says it and switches between the two — only in the lobby and
// on the result screen (never during the 3·2·1 countdown or play: a stray tap would leave the
// game). The lobby subtitle of the session templates says the rule in words (roomMode / roomPin,
// docs/bite-format.md §6.2). Pure, unit-tested in Node (snack-player/test/roomType.test.ts).

export type RoomKind = "public" | "friends";

/** A link with a room code is a friends room; without one, the app's public room. */
export const roomKind = (code: string | null | undefined): RoomKind => (code ? "friends" : "public");

/** The chip: what it says and what a screen reader hears (what a tap does). */
export function roomChip(kind: RoomKind): { icon: string; label: string; aria: string } {
  return kind === "public"
    ? { icon: "🌐", label: "공개방", aria: "지금 공개방 · 눌러서 친구방 만들기" }
    : { icon: "🤝", label: "친구방", aria: "지금 친구방 · 눌러서 공개방으로 가기" };
}

/**
 * The chip shows in a room's lobby and on its result screen only. `phase` is the room's
 * sessionPhase ("" before the first state = the lobby); `inResult` the shell's result view.
 */
export function showRoomChip(o: { withRoom: boolean; failed: boolean; phase: string; inResult: boolean }): boolean {
  if (!o.withRoom || o.failed) return false;
  if (o.inResult) return true;
  return o.phase === "" || o.phase === "lobby" || o.phase === "result";
}

/**
 * What a tap on the chip does. Public → make a friends room (mint). Friends → back to the public
 * room: right away when alone, after a "친구방에서 나갈까요?" sheet when others are in.
 */
export function chipAction(kind: RoomKind, people: number): "mint" | "leave" | "confirm" {
  if (kind === "public") return "mint";
  return people > 1 ? "confirm" : "leave";
}

/**
 * The "친구방에서 나갈까요?" sheet's words. `autoStart`: the public room starts by itself (the room
 * server, and a template with a start payload) — only then does it say so.
 */
export function leaveFriendsCopy(autoStart: boolean) {
  return {
    title: "친구방에서 나갈까요?",
    body: `공개방은 누구나 들어와요${autoStart ? " · 2명이 모이면 바로 시작해요" : ""}. 지금 친구들은 이 친구방에 남아요.`,
    go: "공개방으로 가기",
    stay: "친구방에 있기",
  };
}
