import "streamx";

// `Writable.drained` exists since streamx 2.13 but is missing from
// @types/streamx (2.9.5).
declare module "streamx" {
  namespace Writable {
    function drained(ws: unknown): Promise<boolean>;
  }
}
