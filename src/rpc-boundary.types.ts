/**
 * Types for what the RPC client *actually* delivers across the IPC boundary.
 *
 * `@comapeo/ipc`'s `ComapeoCoreClientApi` is derived from `@comapeo/core`'s
 * `MapeoManager` and types method results with core's **pre-serialization**
 * shapes. But every value that crosses this module's message port goes
 * through `JSON.stringify`/`JSON.parse` (see `CoreMessagePort.postMessage`),
 * so anything that isn't plain JSON arrives transformed: `Date` becomes an
 * ISO string, `Buffer` becomes `{ type: "Buffer", data: number[] }` (its
 * `toJSON()` output), `Map`/`Set` become `{}`, and so on.
 *
 * {@link OverIpc} re-types a client API to tell the truth about that
 * boundary, using type-fest's `Jsonify` (which models `JSON.stringify`
 * semantics, including `toJSON()` methods). This is also the single place
 * where this module's types *intentionally* diverge from core: if we later
 * revive `Date`s on the RN side
 * (https://github.com/digidem/comapeo-core-react-native/issues/1), only the
 * result transform here changes.
 *
 * The `@comapeo/core` these types are derived from is pinned exactly to the
 * version embedded in the backend bundle — see
 * `scripts/check-core-types-pin.mjs`.
 */
import type { Jsonify } from "type-fest";
import type {
  ComapeoCoreClientApi,
  ComapeoProjectClientApi,
  ComapeoServicesClientApi,
} from "@comapeo/ipc/client.js";

/**
 * The EventEmitter method names that `rpc-reflector`'s `ClientApi` passes
 * through untouched (it filters out the `setMaxListeners`-style ones).
 * Hardcoded rather than `keyof EventEmitter` so this module's published
 * types don't require `@types/node` in consumers. A type test asserts this
 * list stays in sync with what `ClientApi` actually leaves on the surface.
 *
 * Note: event *payloads* also cross the JSON boundary but are not
 * re-mapped here — transforming the generic `on(event, listener)`
 * signatures of `tiny-typed-emitter` would destroy their genericity. All
 * current event payloads are already JSON-faithful; issue #1 tracks the
 * boundary semantics.
 */
type EmitterKeys =
  | "addListener"
  | "removeListener"
  | "removeAllListeners"
  | "on"
  | "once"
  | "off"
  | "emit"
  | "eventNames"
  | "listenerCount"
  | "listeners"
  | "rawListeners";

/**
 * `true` when the JSON round-trip is a no-op on `T` as far as consumers can
 * observe. Mutual assignability rather than type-fest's `IsEqual`: `Jsonify`
 * rebuilds object types through a mapped type, so `IsEqual` reports false on
 * cosmetic differences (optional-modifier normalization, intersection
 * flattening) that don't change what code can do with the value.
 */
type JsonFaithful<T> = [T] extends [Jsonify<T>]
  ? [Jsonify<T>] extends [T]
    ? true
    : false
  : false;

/**
 * A method as seen through the RPC boundary. When the resolved value is
 * already JSON-faithful — which is true for almost the whole comapeo
 * surface, since `@comapeo/schema` documents use ISO-string dates — the
 * original function type is kept verbatim. That preservation matters:
 * methods like `setDeviceInfo<T extends Exact<...>>` and `DataType`'s
 * `create`/`update` are generic, and rebuilding their signature via `infer`
 * would silently drop the `Exact` excess-property enforcement.
 */
type OverIpcMethod<F> = F extends (...args: infer A) => Promise<infer R>
  ? [R] extends [void]
    ? F
    : JsonFaithful<R> extends true
      ? F
      : (...args: A) => Promise<Jsonify<R>>
  : F;

/**
 * The call-signature half of a callable namespace. `ClientApi` types nested
 * API objects (e.g. `project.observation`) as
 * `ClientApi<Sub> & (() => Promise<Sub>)` — calling the namespace itself
 * resolves with the serialized server object, so the resolved value is
 * `Jsonify`d (methods dropped). These synthetic call signatures are never
 * generic, so reconstructing them is safe.
 */
type OverIpcCall<T> = T extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => Promise<[R] extends [void] ? R : Jsonify<R>>
  : unknown;

type OverIpcProps<T> = {
  [K in keyof T]: K extends EmitterKeys ? T[K] : OverIpc<T[K]>;
};

/**
 * Re-types an `rpc-reflector` `ClientApi` surface so every method's
 * resolved value reflects the JSON round-trip it actually makes over this
 * module's message port. Structure (nested namespaces, callable
 * intersections, event-emitter methods, method parameters) is preserved;
 * only resolved result types change, and only where `Jsonify` is not an
 * identity.
 */
export type OverIpc<T> = [T] extends [(...args: never[]) => unknown]
  ? keyof T extends never
    ? OverIpcMethod<T> // plain method leaf
    : OverIpcCall<T> & OverIpcProps<T> // callable namespace
  : [T] extends [object]
    ? OverIpcProps<T> // plain namespace (e.g. the top-level manager API)
    : T;

/**
 * The manager client API as delivered over IPC — the type of the `comapeo`
 * export. Same shape as `@comapeo/ipc`'s `ComapeoCoreClientApi`, with
 * resolved values `Jsonify`d where the JSON round-trip changes them.
 * `getProject` is special-cased (mirroring `@comapeo/ipc`'s own definition):
 * it resolves with a live sub-API for the project, not serialized data.
 */
export type ComapeoApi = Omit<OverIpc<ComapeoCoreClientApi>, "getProject"> & {
  getProject: (projectPublicId: string) => Promise<ComapeoProjectApi>;
};

/** The per-project client API as delivered over IPC. */
export type ComapeoProjectApi = OverIpc<ComapeoProjectClientApi>;

/**
 * The app-provided services client API (map server today) as delivered over
 * IPC — the type of the `comapeoServicesClient` export.
 */
export type ComapeoServicesApi = OverIpc<ComapeoServicesClientApi>;
