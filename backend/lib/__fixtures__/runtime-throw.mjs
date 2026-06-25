// Integration fixture for index.test.mjs. Loads the real backend so its
// top-level process.on("uncaughtException") handler is registered, then
// throws after a delay so the test can connect a control-socket client
// before the handler broadcasts the phase:"runtime" error frame and exits.
//
// argv: <comapeoSocketPath> <controlSocketPath> <privateStorageDir>

await import("../../index.js");

setTimeout(() => {
  throw new Error("simulated runtime explosion");
}, 1500);
