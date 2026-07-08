// Fresh Node-process resource numbers on every backend event
// (docs/sentry-integration-plan.md §9b.6). Registered as an event
// processor so the values are re-read at capture time instead of
// snapshotting once at init. Usage tier only — read-at-capture
// frequency is itself usage-shape data — so the processor asks for
// the live tier state on every event rather than baking the flag in
// at registration (event processors outlive re-`init()`).

import os from "node:os";
import fs from "node:fs";

/**
 * Event processor that stamps a `node_resources` context with
 * capture-time free/total memory and (when `storageDir` is set and
 * statfs succeeds) free/total storage of the filesystem holding the
 * private storage dir. A separate context key, not `device`: the
 * backend strips `device`/`os`/`culture` so the native SDK fills them,
 * and these are Node-process numbers, not native device scope.
 *
 * @param {() => { storageDir?: string } | null} getState returns the
 *   current storage dir when the usage tier is on, `null` when the
 *   processor should leave the event untouched.
 * @param {{
 *   freemem?: () => number,
 *   totalmem?: () => number,
 *   statfsSync?: (path: string) => { bsize: number, blocks: number, bavail: number },
 * }} [deps] test seam
 * @returns {(event: any) => any}
 */
export function createNodeResourcesProcessor(getState, deps = {}) {
  const freemem = deps.freemem ?? os.freemem;
  const totalmem = deps.totalmem ?? os.totalmem;
  const statfsSync = deps.statfsSync ?? fs.statfsSync;
  return (event) => {
    const state = getState();
    if (!state) return event;
    /** @type {Record<string, number>} */
    const resources = {
      free_memory: freemem(),
      memory_size: totalmem(),
    };
    if (state.storageDir) {
      try {
        const stats = statfsSync(state.storageDir);
        resources.free_storage = stats.bavail * stats.bsize;
        resources.storage_size = stats.blocks * stats.bsize;
      } catch {
        // Best-effort: a stat failure loses only the storage numbers, never the event.
      }
    }
    event.contexts = event.contexts || {};
    event.contexts.node_resources = resources;
    return event;
  };
}
