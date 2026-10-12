import type { Bus } from "./meshClient";
export const DEFAULT_BROKER: string;
export function mqttBus(o: { url?: string; room: string; prefix?: string; failAfterMs?: number }): (peerId: string) => Bus;
