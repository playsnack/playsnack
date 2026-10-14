import type { Bus } from "./meshClient";
export const DEFAULT_BROKER: string;
/** Join budget: first connect try → room topic subscribed, else failed "timeout". */
export const JOIN_BUDGET_MS: number;
/** One connect try waits this long for CONNACK. */
export const CONNACK_TIMEOUT_MS: number;
export type MqttBus = Bus & { readonly attempts: number };
export function mqttBus(o: {
  url?: string;
  room: string;
  prefix?: string;
  failAfterMs?: number;
  dropAfterMs?: number;
  connectTimeoutMs?: number;
  reconnectMs?: number;
}): (peerId: string) => MqttBus;
