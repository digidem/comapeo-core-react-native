/**
 * Tag keys we set on Sentry events. Centralised so a typo can't
 * silently route an event to the wrong dashboard column.
 *
 * `proc` reflects the actual OS process: iOS is always `main`;
 * Android is `main` for RN/native code in the host UI process and
 * `fgs` for code in the `:ComapeoCore` foreground-service process
 * (Kotlin FGS code AND the embedded nodejs-mobile that runs there).
 */
export const SentryTags = {
  proc: "proc",
  layer: "layer",
  phase: "comapeo.phase",
  state: "comapeo.state",
  source: "source",
  timeout: "timeout",

  procMain: "main",
  procFgs: "fgs",

  layerRn: "rn",
  layerNative: "native",
  layerNode: "node",
} as const;

/**
 * Breadcrumb category names. Single source of truth for the
 * dot-separated category strings so a typo can't silently route
 * crumbs to the wrong dashboard filter.
 */
export const SentryCategories = {
  /** State-machine transitions (STOPPED → STARTING → STARTED …). */
  state: "comapeo.state",
  /** Control-socket parse failures (the `messageerror` event). */
  control: "comapeo.control",
} as const;
