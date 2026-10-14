import type { Bus } from "./meshClient";
export type TokenStore = { get(room: string): string | null; set(room: string, token: string): void };
export function memoryTokens(): TokenStore;
export function wsBus(o: { url: string; room: string; pin?: string; WebSocket?: unknown; failAfterMs?: number; tokens?: TokenStore }): (peerId: string) => Bus;
