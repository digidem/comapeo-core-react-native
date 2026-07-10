import { test } from "node:test";
import assert from "node:assert/strict";

import { createNodeResourcesProcessor } from "./node-resources.js";

test("re-reads memory and storage on every event (fresh, not snapshotted)", () => {
  let free = 1000;
  const processor = createNodeResourcesProcessor(
    () => ({ storageDir: "/data/storage" }),
    {
      freemem: () => free,
      totalmem: () => 4000,
      statfsSync: () => ({ bsize: 4096, blocks: 100, bavail: 25 }),
    },
  );

  const first = processor({});
  assert.equal(first.contexts.node_resources.free_memory, 1000);
  assert.equal(first.contexts.node_resources.memory_size, 4000);
  assert.equal(first.contexts.node_resources.free_storage, 25 * 4096);
  assert.equal(first.contexts.node_resources.storage_size, 100 * 4096);

  free = 500;
  const second = processor({});
  assert.equal(
    second.contexts.node_resources.free_memory,
    500,
    "second capture must re-read the live value",
  );
});

test("usage tier off (null state) leaves the event untouched", () => {
  const processor = createNodeResourcesProcessor(() => null, {
    freemem: () => {
      throw new Error("must not be called");
    },
  });
  const event = { contexts: { app: { app_name: "x" } } };
  assert.equal(processor(event), event);
  assert.equal(event.contexts.node_resources, undefined);
});

test("preserves existing contexts on the event", () => {
  const processor = createNodeResourcesProcessor(() => ({}), {
    freemem: () => 1,
    totalmem: () => 2,
  });
  const event = processor({ contexts: { app: { app_name: "x" } } });
  assert.equal(event.contexts.app.app_name, "x");
  assert.ok(event.contexts.node_resources);
});

test("statfs failure loses only the storage numbers, never the event", () => {
  const processor = createNodeResourcesProcessor(
    () => ({ storageDir: "/gone" }),
    {
      freemem: () => 1,
      totalmem: () => 2,
      statfsSync: () => {
        throw new Error("ENOENT");
      },
    },
  );
  const event = processor({});
  assert.equal(event.contexts.node_resources.free_memory, 1);
  assert.equal(event.contexts.node_resources.free_storage, undefined);
});

test("no storageDir skips the statfs read", () => {
  const processor = createNodeResourcesProcessor(() => ({}), {
    freemem: () => 1,
    totalmem: () => 2,
    statfsSync: () => {
      throw new Error("must not be called");
    },
  });
  const event = processor({});
  assert.equal(event.contexts.node_resources.free_storage, undefined);
});

test("real os/fs reads produce plausible numbers", () => {
  const processor = createNodeResourcesProcessor(() => ({
    storageDir: process.cwd(),
  }));
  const { node_resources: resources } = processor({}).contexts;
  assert.ok(resources.free_memory > 0);
  assert.ok(resources.memory_size >= resources.free_memory);
  assert.ok(resources.storage_size > 0);
});
