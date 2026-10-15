// Spectators (docs/bite-format.md §6.1): someone who opens a room link while a game is in
// its countdown / play watches it until the next start. The room sends `iAmSpectator`
// (this player only) and `spectators` (a count). A template that declares `iAmSpectator`
// shows it itself (speed-trivia-score); for every other one the shell shows a small notice.

/** Room variables the shell reads itself; a template that does not declare them never gets them. */
export const SHELL_ROOM_VARS = new Set(["iAmSpectator", "spectators"]);

type Doc = { vars?: Record<string, unknown> } | null | undefined;
const declares = (doc: Doc, id: string) => Boolean(doc?.vars && Object.prototype.hasOwnProperty.call(doc.vars, id));

/** Hand this room variable to the template? (no "host set undeclared variable" for the shell's own) */
export const forTemplate = (doc: Doc, id: string) => !SHELL_ROOM_VARS.has(id) || declares(doc, id);

/** The shell's notice: only while watching a game in progress, only when the template does not say it. */
export const showSpectatorNotice = (doc: Doc, iAmSpectator: unknown, phase: string) =>
  iAmSpectator === true && (phase === "countdown" || phase === "play") && !declares(doc, "iAmSpectator");

export const SPECTATOR_NOTICE_TEXT = "진행 중인 판이에요 · 다음 판부터 같이 해요";
// Frame coordinates (390 wide): over the templates' NavBar subtitle line (y 97–117 — a phase
// label like "연타!"), under the top-row pills and left of 😀 / 🪲 (shellDocks.test.ts).
export const SPECTATOR_NOTICE_BOX = { x: 16, y: 94, w: 300, h: 28 };
