/**
 * RN-side Sentry metrics layer (Phase 11 §11.2 / §11.6).
 *
 * Thin wrappers around `Sentry.metrics.*` that:
 *   - inject the shared `platform` attribute on every metric so a call
 *     site can never forget it;
 *   - attach `device_class` / `os_major` only on the `.by_device`
 *     mirror metrics (the cardinality split is enforced here, at the
 *     API boundary — see §11.2.c);
 *   - no-op entirely when Sentry is off;
 *   - run a defensive `beforeSendMetric` filter that drops any emission
 *     carrying a forbidden attribute (§11.8).
 *
 * `recordUsage.{screen,feature}` additionally no-op unless
 * `applicationUsageData` is on.
 */
import { Platform } from "react-native";
import * as Sentry from "@sentry/react-native";

import { sentryConfig } from "./sentry";
import { readSentryPreferences } from "./ComapeoCoreModule";
import { isForbiddenMetric } from "./sentry-scrub";

type MetricAttributes = Record<string, string | number | boolean>;

const platformTag = Platform.OS;

function deviceTags(): { device_class: string; os_major: string } {
  const tags = sentryConfig.deviceTags;
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
 * Map an RPC outcome to the bounded `status` tag (§11.8: `ok` /
 * `error` / `timeout`). A timeout is distinguished by name so the
 * dashboard can separate "slow path" from "failed path".
 */
export function rpcStatusFor(error: unknown): string {
  if (!error) return "ok";
  const name =
    error instanceof Error ? error.name : String((error as { name?: string })?.name);
  if (typeof name === "string" && /timeout/i.test(name)) return "timeout";
  return "error";
}

/**
 * Record an RPC client call: the primary `…duration_ms{method,status}`
 * distribution plus the `…by_device{status,device_class,os_major}`
 * mirror. One call site, two writes (§11.2.a).
 */
export function rpcClientMetric(
  method: string,
  status: string,
  ms: number,
): void {
  distribution("comapeo.rpc.client.duration_ms", ms, "millisecond", {
    method,
    status,
  });
  distribution(
    "comapeo.rpc.client.duration_ms.by_device",
    ms,
    "millisecond",
    { status, ...deviceTags() },
  );
}

/** Split out the sync-send slice (§11.2.a `comapeo.rpc.client.send_ms`). */
export function rpcClientSendMetric(method: string, ms: number): void {
  distribution("comapeo.rpc.client.send_ms", ms, "millisecond", { method });
}

/**
 * Feature-usage helpers (§11.4). No-op unless `applicationUsageData` is
 * on. Each emits a breadcrumb (crash-context) and a counter (aggregate
 * cohort analysis). The module ships these; the consumer chooses which
 * screens/features to instrument.
 */
export const recordUsage = {
  screen(name: string): void {
    if (!usageEnabled()) return;
    Sentry.addBreadcrumb({
      category: "comapeo.usage.screen",
      type: "navigation",
      level: "info",
      message: name,
    });
    count("comapeo.usage.screen", { screen: name });
  },
  feature(name: string): void {
    if (!usageEnabled()) return;
    Sentry.addBreadcrumb({
      category: "comapeo.usage.feature",
      type: "default",
      level: "info",
      message: name,
    });
    count("comapeo.usage.feature", { feature: name });
  },
};

function usageEnabled(): boolean {
  if (!sentryUp()) return false;
  const prefs = readSentryPreferences();
  return prefs.diagnosticsEnabled && prefs.applicationUsageData;
}

/** Exposed for tests + the gauge/count primitives if a host needs them. */
export const __metricsInternals = { distribution, count, gauge };
