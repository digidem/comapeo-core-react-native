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
  /**
   * Set when `state` is `"ERROR"`. `errorPhase` is one of the backend's
   * boot phases (`listen-control`, `init`, `construct`, `runtime`) or a
   * native-derived tag (`rootkey`, `node-runtime`, `shutdown-timeout`,
   * `ipc`). `errorMessage` is the human-readable message suitable for
   * developer logs; do not display it directly to end users without
   * translation.
   */
  errorPhase?: string;
  errorMessage?: string;
};

/**
 * Detail captured from the most recent ERROR transition. `null` when the
 * service has not entered ERROR since process start.
 */
export type ComapeoErrorInfo = {
  errorPhase: string;
  errorMessage: string;
};
