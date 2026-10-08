export type Bus = { publish(m: object): void; onMessage(fn: (m: object) => void): void; close(): void; ready?: Promise<void> };
export function connectMesh(o: {
  createBus: (peerId: string) => Bus;
  me: { slug: string; anonId: string; nick: string };
  onMessage: (m: { t: string; d: Record<string, unknown> }) => void;
  getPack?: (game: string, opts: { theme?: string }) => Promise<unknown[] | null>;
  onRole?: (isHost: boolean) => void;
  timing?: { discoveryMs?: number; beatMs?: number; silenceMs?: number; snapshotMs?: number };
  engine?: Record<string, unknown>;
}): { readonly isHost: boolean; readonly peerId: string; sendAction(name: string, payload: unknown, clientMsgId: string): void; sendReaction(emoji: string): void; handoff(): void; close(): void };
