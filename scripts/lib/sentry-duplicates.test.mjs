import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findDuplicateSentryPackages } from "./sentry-duplicates.mjs";

describe("findDuplicateSentryPackages", () => {
  it("reports a runtime package nested at a second version", () => {
    const lock = {
      packages: {
        "": { name: "backend" },
        "node_modules/@sentry/core": { version: "10.78.0" },
        "node_modules/@sentry/node-core": { version: "10.75.2" },
        "node_modules/@sentry/node-core/node_modules/@sentry/core": {
          version: "10.75.2",
        },
      },
    };
    assert.deepEqual(
      findDuplicateSentryPackages(lock),
      new Map([["@sentry/core", ["10.75.2", "10.78.0"]]])
    );
  });

  it("ignores dev-only copies and single versions", () => {
    const lock = {
      packages: {
        "node_modules/@sentry/core": { version: "10.78.0" },
        "node_modules/@sentry/opentelemetry": { version: "10.78.0" },
        "node_modules/@sentry/cli": { version: "3.5.1", dev: true },
        "node_modules/@sentry/bundler-plugins/node_modules/@sentry/cli": {
          version: "2.58.6",
          dev: true,
        },
      },
    };
    assert.equal(findDuplicateSentryPackages(lock).size, 0);
  });
});
