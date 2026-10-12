export type BusStatus = { state: "failed"; reason?: string };
export type Bus = {
  publish(m: object): void;
  onMessage(fn: (m: object) => void): void;
  close(): void;
  ready?: Promise<void>;
  onStatus?(fn: (s: BusStatus) => void): void;
};
export type MeshStatus = { state: "connecting" | "connected" | "failed"; reason?: string };
export function connectMesh(o: {
  createBus: (peerId: string) => Bus;
  me: { slug: string; anonId: string; nick: string };
  onMessage: (m: { t: string; d: Record<string, unknown> }) => void;
  getPack?: (game: string, opts: { theme?: string }) => Promise<unknown[] | null>;
  onRole?: (isHost: boolean) => void;
  onStatus?: (s: MeshStatus) => void;
  timing?: { discoveryMs?: number; beatMs?: number; silenceMs?: number; snapshotMs?: number; resendMs?: number };
  engine?: Record<string, unknown>;
  debug?: (event: string, info: object) => void;
}): { readonly isHost: boolean; readonly peerId: string; sendAction(name: string, payload: unknown, clientMsgId: string): void; sendReaction(emoji: string): void; handoff(): void; close(): void };
