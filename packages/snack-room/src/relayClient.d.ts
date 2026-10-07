export function connectRelay(o: {
  url: string;
  WebSocket: unknown;
  me: { slug: string; anonId: string; nick: string };
  onMessage: (m: { t: string; d: Record<string, unknown> }) => void;
  getPack?: (game: string, opts: { theme?: string }) => Promise<unknown[] | null>;
  onRole?: (isHost: boolean) => void;
  eventsUrl?: string;
  engine?: Record<string, unknown>;
}): { readonly isHost: boolean; sendAction(name: string, payload: unknown, clientMsgId: string): void; sendReaction(emoji: string): void; handoff(): void; close(): void };
