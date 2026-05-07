// @ts-check
import MagicString from "magic-string";

/**
 * Rewrites `module.register('import-in-the-middle/hook.mjs', ...)` to
 * `module.register('./importHook.js', ...)` so the runtime register
 * call points at the bundled hook entry rather than the
 * `node_modules/` path that no longer exists post-bundle.
 *
 * `import-in-the-middle/hook.mjs` is what `@sentry/node` (via
 * `@opentelemetry/instrumentation`) passes to `module.register` to
 * install its module-loading hook. `module.register` requires a
 * separate file loaded fresh in a child loader thread, so it can't
 * be inlined into the calling chunk — we ship it as the dedicated
 * `importHook` rollup entry and rewrite the path to match.
 *
 * Ported verbatim from
 * `comapeo-mobile/src/backend/rollup-plugins/rollup-plugin-import-hook.mjs`.
 *
 * @returns {import('rollup').Plugin}
 */
export default function importHookPlugin() {
  return {
    name: "rollup-plugin-import-hook",

    transform(code) {
      if (!code.includes("import-in-the-middle")) return null;

      const magicString = new MagicString(code);

      magicString.replaceAll(
        /register\(['"]import-in-the-middle\/hook\.mjs['"]/g,
        "register('./importHook.js'",
      );

      if (!magicString.hasChanged()) {
        return null;
      }

      return {
        code: magicString.toString(),
        map: magicString.generateMap({ hires: true }),
      };
    },
  };
}
