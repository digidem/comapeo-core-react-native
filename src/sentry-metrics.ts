/**
 * RN-side Sentry metrics layer.
 *
 * Thin wrappers around `Sentry.metrics.*` that:
 *   - inject the shared `platform` attribute on every metric so a call
 *     site can never forget it;
 *   - attach `device_class` / `os_major` only on the `.by_device`
 *     mirror metrics (the cardinality split is enforced here, at the
 *     API boundary);
 *   - no-op entirely when Sentry is off;
 *   - run a defensive `beforeSendMetric` filter that drops any emission
 *     carrying a forbidden attribute.
 */
import { Platform } from "react-native";
import * as Sentry from "@sentry/react-native";

import { readSentryConfig, readSentryPreferences } from "./ComapeoCoreModule";
import type { SentryDeviceTags } from "./sentry";
import { isForbiddenMetric } from "./sentry-scrub";

type MetricAttributes = Record<string, string | number | boolean>;

const platformTag = Platform.OS;

// Device tags + usage tier are snapshot-at-boot (native Constants that can't
// change in-process), memoised lazily on first metric so nothing reads the
// native module at import time — this file is imported by ComapeoCoreModule
// before its `nativeModule` binding is initialised.
let deviceTagsSnapshot: SentryDeviceTags | null | undefined;
let usageDataSnapshot: boolean | undefined;

/**
 * Opt-in tier for usage-revealing dimensions (the RPC `method` breakdown).
 * Snapshot-at-boot; restart-to-activate.
 */
function usageDataEnabled(): boolean {
  return (usageDataSnapshot ??= readSentryPreferences().applicationUsageData);
}

function deviceTags(): { device_class: string; os_major: string } {
  if (deviceTagsSnapshot === undefined) {
    deviceTagsSnapshot = readSentryConfig().deviceTags ?? null;
  }
  const tags = deviceTagsSnapshot;
  return {
    device_class: tags?.deviceClass ?? "unknown",
    os_major: tags?.osMajor ?? `${platformTag}.0`,
  };
}

function sentryUp(): boolean {
  const isInitialized = (
    Sentry as unknown as { isInitialized?: () => boolean }
  ).isInitialized;
  return typeof isInitialized !== "function" || isInitialized();
}

const metricsApi = (): {
  distribution?: (
    name: string,
    value: number,
    data?: { unit?: string; attributes?: MetricAttributes },
  ) => void;
  count?: (
    name: string,
    value: number,
    data?: { attributes?: MetricAttributes },
  ) => void;
  gauge?: (
    name: string,
    value: number,
    data?: { unit?: string; attributes?: MetricAttributes },
  ) => void;
} | null => {
  const api = (Sentry as unknown as { metrics?: unknown }).metrics;
  return (api as ReturnType<typeof metricsApi>) ?? null;
};

function withPlatform(attributes: MetricAttributes): MetricAttributes {
  return { platform: platformTag, ...attributes };
}

/** No-op when Sentry is off or the metric trips the forbidden filter. */
function distribution(
  name: string,
  value: number,
  unit: string,
  attributes: MetricAttributes,
): void {
  if (!sentryUp()) return;
  const attrs = withPlatform(attributes);
  if (isForbiddenMetric(name, attrs)) return;
  metricsApi()?.distribution?.(name, value, { unit, attributes: attrs });
}

function count(name: string, attributes: MetricAttributes): void {
  if (!sentryUp()) return;
  const attrs = withPlatform(attributes);
  if (isForbiddenMetric(name, attrs)) return;
  metricsApi()?.count?.(name, 1, { attributes: attrs });
}

function gauge(
  name: string,
  value: number,
  unit: string,
  attributes: MetricAttributes,
): void {
  if (!sentryUp()) return;
  const attrs = withPlatform(attributes);
  if (isForbiddenMetric(name, attrs)) return;
  metricsApi()?.gauge?.(name, value, { unit, attributes: attrs });
}

/**
 * Classify an RPC *failure* into the bounded `status` tag (`error` /
 * `timeout`) — a timeout is distinguished by name so the dashboard can
 * separate "slow path" from "failed path". Only call this on the reject
 * path; the success path records `"ok"` directly. A falsy rejection
 * reason still counts as a failure (never `ok`).
 */
export function rpcStatusFor(error: unknown): string {
  const name =
    error instanceof Error ? error.name : String((error as { name?: string })?.name);
  if (/timeout/i.test(name)) return "timeout";
  return "error";
}

/**
 * Record an RPC client call. The `…by_device{status,device_class,os_major}`
 * mirror always flows (diagnostic latency); the `…duration_ms{method,status}`
 * primary carries the per-method breakdown and is usage-gated.
 */
export function rpcClientMetric(
  method: string,
  status: string,
  ms: number,
): void {
  if (usageDataEnabled()) {
    distribution("comapeo.rpc.client.duration_ms", ms, "millisecond", {
      method,
      status,
    });
  }
  distribution(
    "comapeo.rpc.client.duration_ms.by_device",
    ms,
    "millisecond",
    { status, ...deviceTags() },
  );
}

/**
 * Sync-send slice (`comapeo.rpc.client.send_ms`). The aggregate flows at
 * the diagnostic tier; the `method` breakdown is usage-gated.
 */
export function rpcClientSendMetric(method: string, ms: number): void {
  const attributes: MetricAttributes = usageDataEnabled() ? { method } : {};
  distribution("comapeo.rpc.client.send_ms", ms, "millisecond", attributes);
}

/** Exposed for tests + the gauge/count primitives if a host needs them. */
export const __metricsInternals = { distribution, count, gauge };
