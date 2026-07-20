/**
 * `SubscriptionLog` — the record/replay of rpc-reflector `ON`/`OFF`
 * frames that keeps `discovery-state` / `local-peers` alive across an
 * embedded-backend restart (src/rpc-subscriptions.ts).
 */

const { SubscriptionLog } = require("../rpc-subscriptions");

// rpc-reflector frame tags.
const ON = 2;
const OFF = 3;

describe("SubscriptionLog", () => {
  it("records ON frames and replays them verbatim", () => {
    const log = new SubscriptionLog();
    const a = [ON, "discovery-state", ["discovery"]];
    const b = [ON, "local-peers", []];
    log.record(a);
    log.record(b);
    expect(log.activeFrames()).toEqual([a, b]);
  });

  it("dedupes repeat ON for the same event", () => {
    const log = new SubscriptionLog();
    log.record([ON, "local-peers", []]);
    log.record([ON, "local-peers", []]);
    expect(log.activeFrames()).toHaveLength(1);
  });

  it("drops a subscription on OFF, keyed by event + propArray", () => {
    const log = new SubscriptionLog();
    log.record([ON, "discovery-state", ["discovery"]]);
    log.record([ON, "local-peers", []]);
    log.record([OFF, "local-peers", []]);
    expect(log.activeFrames()).toEqual([
      [ON, "discovery-state", ["discovery"]],
    ]);
  });

  it("distinguishes same event name under different propArrays", () => {
    const log = new SubscriptionLog();
    log.record([ON, "x", ["a"]]);
    log.record([ON, "x", ["b"]]);
    log.record([OFF, "x", ["a"]]);
    expect(log.activeFrames()).toEqual([[ON, "x", ["b"]]]);
  });

  it("ignores request frames (objects) and malformed arrays", () => {
    const log = new SubscriptionLog();
    log.record({ value: { method: ["foo"], args: [] }, metadata: {} });
    log.record([1, "response-shaped"]);
    log.record([ON]); // too short
    log.record("not-a-frame");
    log.record(null);
    expect(log.activeFrames()).toEqual([]);
  });
});
