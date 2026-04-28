export type OnLoadEventPayload = {
  url: string;
};

/**
 * Lifecycle states reported by the embedded Node.js / CoMapeo Core service.
 * Strings match the iOS `NodeJSService.State` rawValue and the Android
 * `JsState` enum so the union is platform-independent.
 *
 * - `STOPPED`  — service is not running.
 * - `STARTING` — Node has spawned and the rootkey handshake is in flight,
 *                or the JS bridge has not yet received the backend's `ready`
 *                broadcast.
 * - `STARTED`  — `MapeoManager` is constructed and RPC is safe to use.
 * - `STOPPING` — graceful shutdown initiated.
 * - `ERROR`    — terminal: rootkey load failed, or shutdown timed out with
 *                the node thread still alive.
 */
export type ComapeoState =
  | "STOPPED"
  | "STARTING"
  | "STARTED"
  | "STOPPING"
  | "ERROR";

export type ComapeoCoreModuleEvents = {
  message: (params: MessageEventPayload) => void;
  stateChange: (params: StateChangeEventPayload) => void;
};

export type MessageEventPayload = {
  data: string;
};

export type MessageErrorEventPayload = {
  data: Error;
};

export type StateChangeEventPayload = {
  state: ComapeoState;
};
