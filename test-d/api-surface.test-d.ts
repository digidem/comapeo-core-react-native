/**
 * Compile-time assertions pinning the published API surface against the
 * exact `@comapeo/core` version the backend bundles (see
 * `scripts/check-core-types-pin.mjs`). Run with `npm run test:types`.
 *
 * These serve two purposes:
 *
 * 1. **Boundary correctness** — the `OverIpc` transform in
 *    `src/rpc-boundary.types.ts` must preserve the client API's structure
 *    (keys, parameters, emitter methods, generic signatures) and only
 *    re-type resolved values where the JSON round-trip changes them.
 * 2. **Core-bump review point** — bumping `@comapeo/core` recompiles these
 *    against the new API; a failure here means the published type surface
 *    changed shape and the change should be reviewed (and possibly called
 *    out as breaking) rather than shipped silently.
 *
 * This file is compile-only: nothing here runs. `Expect<T extends true>`
 * fails compilation when an assertion doesn't hold.
 */
import type { IsEqual } from "type-fest";
import type {
  ComapeoCoreClientApi,
  ComapeoProjectClientApi,
} from "@comapeo/ipc/client.js";
import type { EventEmitter } from "events";
import type {
  ComapeoApi,
  ComapeoProjectApi,
} from "../src/rpc-boundary.types";
import type { comapeo, comapeoServicesClient } from "../src";

type Expect<T extends true> = T;

// The exported singletons carry the boundary-corrected types.
type ComapeoExportIsBoundaryTyped = Expect<
  IsEqual<typeof comapeo, ComapeoApi>
>;

// ---------------------------------------------------------------------------
// Structure preservation: OverIpc must not add or drop API members.
// ---------------------------------------------------------------------------

type ManagerKeysPreserved = Expect<
  IsEqual<keyof ComapeoApi, keyof ComapeoCoreClientApi>
>;
type ProjectKeysPreserved = Expect<
  IsEqual<keyof ComapeoProjectApi, keyof ComapeoProjectClientApi>
>;

// EventEmitter methods pass through verbatim (their payloads are typed by
// core's TypedEmitter generics; re-mapping them would break genericity).
// `EmitterKeys` in rpc-boundary.types.ts is hardcoded to avoid a consumer
// dependency on @types/node — this pins it against the real thing.
type SurfaceEmitterKeys = Extract<keyof ComapeoCoreClientApi, keyof EventEmitter>;
type EmitterMethodsPassThrough = Expect<
  IsEqual<
    Pick<ComapeoApi, SurfaceEmitterKeys>,
    Pick<ComapeoCoreClientApi, SurfaceEmitterKeys>
  >
>;

// Generic methods must keep their `Exact<...>` excess-property enforcement:
// OverIpc passes JSON-faithful methods through verbatim rather than
// reconstructing their signatures.
type SetDeviceInfoPreserved = Expect<
  IsEqual<ComapeoApi["setDeviceInfo"], ComapeoCoreClientApi["setDeviceInfo"]>
>;
type ObservationCreatePreserved = Expect<
  IsEqual<
    ComapeoProjectApi["observation"]["create"],
    ComapeoProjectClientApi["observation"]["create"]
  >
>;

// Method parameters are never transformed.
type AddProjectParamsPreserved = Expect<
  IsEqual<
    Parameters<ComapeoApi["addProject"]>,
    Parameters<ComapeoCoreClientApi["addProject"]>
  >
>;

// ---------------------------------------------------------------------------
// The RPC boundary's special cases.
// ---------------------------------------------------------------------------

// getProject resolves with a live project sub-API (routed by @comapeo/ipc),
// not serialized data.
type GetProjectResolvesSubApi = Expect<
  IsEqual<
    Awaited<ReturnType<ComapeoApi["getProject"]>>,
    ComapeoProjectApi
  >
>;

// Nested namespaces stay callable (rpc-reflector's
// `ClientApi<Sub> & (() => Promise<Sub>)` shape survives the transform) and
// keep their nested methods.
type ObservationNamespaceCallable =
  ComapeoProjectApi["observation"] extends (...args: never[]) => Promise<unknown>
    ? true
    : false;
type ObservationNamespaceCallablePreserved = Expect<ObservationNamespaceCallable>;

// ---------------------------------------------------------------------------
// Data honesty: what method results actually look like after the JSON
// round-trip. These double as canaries for @comapeo/core API changes.
// ---------------------------------------------------------------------------

type Observation = Awaited<
  ReturnType<ComapeoProjectApi["observation"]["getByDocId"]>
>;

// Schema documents use ISO-string dates end-to-end, so the boundary is
// currently an identity on them. If core ever puts a `Date` (or `Buffer`,
// `Map`, ...) on a client-visible result, OverIpc re-types it and the
// `...Preserved` assertions above localize exactly which methods diverged.
type ObservationDatesAreStrings = Expect<
  IsEqual<NonNullable<Observation>["createdAt"], string>
>;

type DeviceInfo = Awaited<ReturnType<ComapeoApi["getDeviceInfo"]>>;
type DeviceInfoHasDeviceId = Expect<
  IsEqual<DeviceInfo["deviceId"], string>
>;

// Services client (map server) keeps its surface.
type ServicesBaseUrl = Awaited<
  ReturnType<(typeof comapeoServicesClient)["mapServer"]["getBaseUrl"]>
>;
type ServicesBaseUrlIsString = Expect<IsEqual<ServicesBaseUrl, string>>;

// Referencing the assertion aliases keeps noUnusedLocals happy and makes the
// file's exports a summary of everything it pins.
export type Assertions = [
  ComapeoExportIsBoundaryTyped,
  ManagerKeysPreserved,
  ProjectKeysPreserved,
  EmitterMethodsPassThrough,
  SetDeviceInfoPreserved,
  ObservationCreatePreserved,
  AddProjectParamsPreserved,
  GetProjectResolvesSubApi,
  ObservationNamespaceCallablePreserved,
  ObservationDatesAreStrings,
  DeviceInfoHasDeviceId,
  ServicesBaseUrlIsString,
];
