export type HostFieldType = "string" | "number" | "boolean" | "array" | "object";

export interface HostField {
  type: HostFieldType | HostFieldType[];
  required?: boolean;
  enum?: string[];
  /** Free text (content/game id): a string equal to a variable name only warns. */
  text?: boolean;
}

export interface HostAction {
  payload: "none" | "object";
  /** A bare number is also accepted (start: duration in ms). */
  number?: boolean;
  fields?: Record<string, HostField>;
  description?: string;
}

export type HostActions = Readonly<Record<string, HostAction>>;

/** Payload contract of every room action, mirroring room.js `action()`. */
export const HOST_ACTIONS: HostActions;
