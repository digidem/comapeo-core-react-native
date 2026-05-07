// @ts-check
import MagicString from "magic-string";

/**
 * Rewrites `module.register('import-in-the-middle/hook.mjs', ...)` to
 * the bundled `./importHook.js` entry. Ported from
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
