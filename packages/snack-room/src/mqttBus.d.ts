import type { Bus } from "./meshClient";
export const PUBLIC_BROKERS: string[];
export function mqttBus(o: { url?: string; room: string; prefix?: string }): (peerId: string) => Bus;
