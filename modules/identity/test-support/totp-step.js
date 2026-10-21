// For tests that use real one-time passwords against a server running on the real clock. A code is bound to a 30-second step and the server accepts the step it is in and
// one either side, so a code worked out just before a step ends can be too old by the time the request arrives. Waiting until the start of a step (or until enough of the
// current one is left) before a short sequence of uses keeps a test from failing once in a few dozen runs on a slow machine.
export const STEP_MS = 30_000;
export async function midStep(minimumRemainingMs = 10_000) {
  const remaining = STEP_MS - (Date.now() % STEP_MS);
  if (remaining < minimumRemainingMs) await new Promise(resolve => setTimeout(resolve, remaining + 500));
}
