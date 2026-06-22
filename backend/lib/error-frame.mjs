/**
 * Build the `error` frame broadcast to native on a fatal failure. Pure
 * so a test can assert the frame shape and phase routing without driving
 * a real socket or killing the process.
 *
 * @param {string} phase
 * @param {Error} err
 * @returns {{ type: "error", phase: string, message: string, stack: string | undefined }}
 */
export function errorFrame(phase, err) {
  return {
    type: "error",
    phase,
    message: err.message,
    stack: err.stack,
  };
}
