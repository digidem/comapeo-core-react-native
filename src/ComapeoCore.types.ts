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
 * - `ERROR`    — observable failure (rootkey load, backend boot, shutdown
 *                timeout, IPC connect). The native layer does not tear
 *                down the node thread on ERROR — recovery is the
 *                application's responsibility (e.g. restart the FGS on
 *                Android, recreate the service / restart on iOS, prompt
 *                the user, log a report). `state.getLastError()` carries
 *                structured detail.
 */
export type ComapeoState =
  | "STOPPED"
  | "STARTING"
  | "STARTED"
  | "STOPPING"
  | "ERROR";

export type ComapeoCoreModuleEvents = {
  message: (params: MessageEventPayload) => void;
  messageerror: (params: MessageErrorEventPayload) => void;
  stateChange: (params: StateChangeEventPayload) => void;
};

export type MessageEventPayload = {
  data: string;
};

/**
 * Payload for the `messageerror` event. Mirrors the DOM MessagePort
 * counterpart in spirit: fired when a frame the native side received
 * on the control socket couldn't be processed (non-JSON, missing
 * `type`, or unknown `type`). `data` is a developer-facing description
 * of the offending frame; the JS-facing `state.messageerror` listener
 * receives this wrapped in an `Error` for ergonomics.
 *
 * A `messageerror` event does NOT cause a lifecycle state transition —
 * the control socket continues to drive `stateChange` independently.
 */
export type MessageErrorEventPayload = {
  data: string;
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

/**
 * Status of the notification permission. Mirrors expo-modules-core's
 * `PermissionStatus`:
 * - `granted`      — the user allowed notifications.
 * - `denied`       — the user said no.
 * - `undetermined` — never asked, so a request will show the system dialog.
 */
export type NotificationPermissionStatus = "granted" | "denied" | "undetermined";

/**
 * Result of checking or requesting the notification permission. Same shape
 * as expo's `PermissionResponse` so host code can treat it interchangeably
 * with permissions from `expo-camera`, `expo-location`, etc.
 *
 * On Android < 13 (API 33) and on iOS this always resolves as `granted`:
 * `POST_NOTIFICATIONS` is a no-op runtime permission there, so the
 * foreground-service notification shows without an explicit grant.
 */
export type NotificationPermissionResponse = {
  status: NotificationPermissionStatus;
  /** Convenience flag, `true` only when `status === "granted"`. */
  granted: boolean;
  /**
   * `false` once the user has denied with "Don't ask again" (Android) —
   * the system dialog won't show again and the host must deep-link the
   * user to the app's notification settings instead.
   */
  canAskAgain: boolean;
  /** Always `"never"`; notification grants don't expire. */
  expires: "never" | number;
};
