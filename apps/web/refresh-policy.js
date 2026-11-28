// When the console fetches the heavy data: the whole virtual machine list and the live performance numbers, which together grow with the estate (about 17 MB at 10,000
// machines, docs/scale-test.md). Everything else is refreshed every five seconds as before. Pure functions, kept apart from app.js so they can be tested in node.
//
// The heavy data is fetched when something asks for it (any load that is not the five-second timer's: sign-in, after an action, Refresh), and on the timer only when it has
// become old or something that changes how machines look has happened. A change made outside Nuvrion is therefore seen within about half a minute, which is well inside the two
// minutes after which the console calls a reading stale.
export const HEAVY_EVERY_MS = 30_000;
export const HEAVY_ON_OPEN_MS = 5_000;        // opening a page shows data no older than this

// What, in the data fetched every five seconds, means the machines may now look different: a task that appeared, ended or changed state, or a connection that was added, removed,
// switched or changed health. The times of the last successful discovery are left out on purpose: they change every few seconds while everything is fine.
export function changeSignature({ tasks = [], connections = [] } = {}) {
  const parts = [
    ...tasks.map(task => `task ${task.id} ${task.status}`),
    ...connections.map(connection => `connection ${connection.id} ${connection.status} ${connection.healthState} ${connection.lastErrorCode ?? ''}`)
  ];
  return parts.sort().join('\n');
}

export function heavyDue({ background, fetchedAt, fetchedSignature, signature, now }) {
  if (!background || fetchedAt === null || fetchedAt === undefined) return true;
  return now - fetchedAt >= HEAVY_EVERY_MS || signature !== fetchedSignature;
}

// Whether opening a page should fetch afresh. Before the first fetch there is nothing to refresh: the sign-in load is already on its way.
export function staleOnOpen(fetchedAt, now) {
  return fetchedAt !== null && fetchedAt !== undefined && now - fetchedAt >= HEAVY_ON_OPEN_MS;
}
