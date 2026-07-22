import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDiscoveryQuery,
  evaluateBootTrace,
  findPii,
  normalizeTags,
  spanOps,
} from "./sentry-tripwire-core.mjs";

const TRACE_ID = "aaaabbbbccccddddeeeeffff00001111";

/** Fixture: the FGS-emitted comapeo.boot transaction (sentry-java shape). */
function bootPayload(overrides = {}) {
  return {
    event_id: "boot-event-1",
    type: "transaction",
    transaction: "comapeo.boot",
    release: "1.0.0+42",
    environment: "smoke-1",
    contexts: {
      trace: { trace_id: TRACE_ID, op: "comapeo.boot" },
      device: { family: "Android", model: "Pixel 7a" },
    },
    // sentry-java serialises tags as an object.
    tags: {
      proc: "fgs",
      layer: "native",
      "comapeo.rn": "1.0.0-pre.8+gitabc123",
      "boot.kind": "user-foreground",
    },
    spans: [
      { op: "boot.fgs-launch", description: "boot.fgs-launch" },
      { op: "boot.extract-assets", description: "boot.extract-assets" },
      { op: "boot.node-spawn", description: "boot.node-spawn" },
      { op: "boot.rootkey-load", description: "boot.rootkey-load" },
    ],
    ...overrides,
  };
}

/** Fixture: a Node-side boot transaction (continues the FGS trace). */
function nodePayload(name, overrides = {}) {
  return {
    event_id: `node-${name}`,
    type: "transaction",
    transaction: name,
    release: "1.0.0+42",
    environment: "smoke-1",
    contexts: { trace: { trace_id: TRACE_ID, op: name } },
    tags: { proc: "fgs", layer: "node" },
    spans:
      name === "boot.loader-init"
        ? [{ op: "boot.import-index", description: "boot.import-index" }]
        : [],
    ...overrides,
  };
}

function fullTrace() {
  return [
    bootPayload(),
    nodePayload("boot.loader-init"),
    nodePayload("boot.manager-init"),
  ];
}

describe("buildDiscoveryQuery", () => {
  it("builds a trace query", () => {
    assert.equal(
      buildDiscoveryQuery({ traceId: TRACE_ID }),
      `transaction:comapeo.boot trace:${TRACE_ID}`,
    );
  });

  it("builds an environment query", () => {
    assert.equal(
      buildDiscoveryQuery({ environment: "smoke-1" }),
      "transaction:comapeo.boot environment:smoke-1",
    );
  });

  it("rejects zero or two selectors", () => {
    assert.throws(() => buildDiscoveryQuery({}));
    assert.throws(() =>
      buildDiscoveryQuery({ traceId: TRACE_ID, environment: "smoke-1" }),
    );
  });
});

describe("normalizeTags", () => {
  it("handles object, pair-array, and key/value-array forms", () => {
    const expected = { proc: "fgs", layer: "native" };
    assert.deepEqual(normalizeTags({ tags: expected }), expected);
    assert.deepEqual(
      normalizeTags({
        tags: [
          ["proc", "fgs"],
          ["layer", "native"],
        ],
      }),
      expected,
    );
    assert.deepEqual(
      normalizeTags({
        tags: [
          { key: "proc", value: "fgs" },
          { key: "layer", value: "native" },
        ],
      }),
      expected,
    );
    assert.deepEqual(normalizeTags({}), {});
  });
});

describe("spanOps", () => {
  it("collects span ops, ignoring malformed entries", () => {
    assert.deepEqual(
      spanOps({ spans: [{ op: "boot.node-spawn" }, {}, { op: 3 }] }),
      ["boot.node-spawn"],
    );
    assert.deepEqual(spanOps({}), []);
  });
});

describe("findPii", () => {
  it("flags rootkey and coordinate markers in strings", () => {
    const hits = findPii({
      message: "failed with rootKey=c2VjcmV0a2V5 during load",
      extra: { detail: "at lat: -12.34, lon: 45.6" },
    });
    assert.equal(hits.length, 3);
    assert.match(hits[0], /rootKey=/);
  });

  it("flags sensitive keys with unredacted values", () => {
    const hits = findPii({ extra: { lat: -12.34, rootKey: "abc" } });
    assert.equal(hits.length, 2);
  });

  it("accepts redacted values and clean events", () => {
    assert.deepEqual(
      findPii({
        message: "failed with [redacted] during load",
        extra: { lat: "[redacted]" },
        contexts: { trace: { trace_id: TRACE_ID } },
      }),
      [],
    );
  });
});

describe("evaluateBootTrace", () => {
  it("passes on a complete Android boot trace", () => {
    const report = evaluateBootTrace(fullTrace(), {
      platform: "android",
      environment: "smoke-1",
      release: "1.0.0+42",
    });
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.warnings, []);
    assert.equal(report.ok, true);
  });

  it("passes on an iOS boot trace without fgs-launch/extract-assets", () => {
    const boot = bootPayload({
      tags: { proc: "main", layer: "native", "comapeo.rn": "1.0.0" },
      spans: [{ op: "boot.node-spawn" }, { op: "boot.rootkey-load" }],
    });
    const report = evaluateBootTrace(
      [boot, nodePayload("boot.loader-init"), nodePayload("boot.manager-init")],
      { platform: "ios" },
    );
    assert.deepEqual(report.failures, []);
  });

  it("fails when no boot transaction arrived", () => {
    const report = evaluateBootTrace([nodePayload("boot.loader-init")]);
    assert.equal(report.ok, false);
    assert.match(report.failures[0], /No comapeo\.boot transaction/);
  });

  it("fails on a missing native child span", () => {
    const boot = bootPayload({
      spans: [{ op: "boot.fgs-launch" }, { op: "boot.rootkey-load" }],
    });
    const report = evaluateBootTrace([
      boot,
      nodePayload("boot.loader-init"),
      nodePayload("boot.manager-init"),
    ]);
    assert.ok(
      report.failures.some((f) => f.includes("missing child span boot.node-spawn")),
      report.failures.join("\n"),
    );
  });

  it("warns (not fails) when extract-assets is absent on Android", () => {
    const boot = bootPayload({
      spans: [
        { op: "boot.fgs-launch" },
        { op: "boot.node-spawn" },
        { op: "boot.rootkey-load" },
      ],
    });
    const report = evaluateBootTrace([
      boot,
      nodePayload("boot.loader-init"),
      nodePayload("boot.manager-init"),
    ]);
    assert.deepEqual(report.failures, []);
    assert.match(report.warnings[0], /boot\.extract-assets/);
  });

  it('fails when device.family is "Google" on the FGS transaction', () => {
    const boot = bootPayload();
    boot.contexts.device.family = "Google";
    const report = evaluateBootTrace([
      boot,
      nodePayload("boot.loader-init"),
      nodePayload("boot.manager-init"),
    ]);
    assert.ok(
      report.failures.some((f) => f.includes('"Google"')),
      report.failures.join("\n"),
    );
  });

  it("fails when a Node-side transaction is missing or on another trace", () => {
    const strayManagerInit = nodePayload("boot.manager-init", {
      contexts: { trace: { trace_id: "0".repeat(32), op: "boot.manager-init" } },
    });
    const report = evaluateBootTrace([
      bootPayload(),
      nodePayload("boot.loader-init"),
      strayManagerInit,
    ]);
    assert.ok(
      report.failures.some((f) => f.includes("boot.manager-init")),
      report.failures.join("\n"),
    );
  });

  it("fails on wrong proc/layer tags and a missing comapeo.rn tag", () => {
    const boot = bootPayload({ tags: { proc: "main", layer: "rn" } });
    const report = evaluateBootTrace([
      boot,
      nodePayload("boot.loader-init"),
      nodePayload("boot.manager-init"),
    ]);
    assert.equal(
      report.failures.filter(
        (f) => f.includes("proc=") || f.includes("layer=") || f.includes("comapeo.rn"),
      ).length,
      3,
      report.failures.join("\n"),
    );
  });

  it("fails on an environment/release mismatch", () => {
    const report = evaluateBootTrace(fullTrace(), {
      environment: "other-env",
      release: "9.9.9",
    });
    assert.ok(report.failures.some((f) => f.includes("environment=")));
    assert.ok(report.failures.some((f) => f.includes("release=")));
  });

  it("fails when an event contains PII markers", () => {
    const boot = bootPayload();
    boot.spans.push({
      op: "boot.rootkey-load",
      description: "loaded rootKey=c2VjcmV0a2V5",
    });
    const report = evaluateBootTrace([
      boot,
      nodePayload("boot.loader-init"),
      nodePayload("boot.manager-init"),
    ]);
    assert.ok(
      report.failures.some((f) => f.includes("possible PII")),
      report.failures.join("\n"),
    );
  });
});
