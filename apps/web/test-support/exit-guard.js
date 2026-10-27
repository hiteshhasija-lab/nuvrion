// A browser test file's process has to end when its tests end. In CI it sometimes did not (23 to 27 October: after console tests had failed, the process stayed alive, `node --test` waited for it, nothing more was
// reported and the job was cancelled at its 15-minute limit, with no failure messages). The cause was not found; this does not need it. Call it from the file's `after` hook, once the browser and the lab server are
// closed: if the process is still alive `seconds` later it says what is keeping it alive and ends it. The timer is unref'd, so it never delays a process that ends by itself, and the runner takes the results of the
// tests from what the file reported, so a failure is still a failure.
export function exitWhenIdle(seconds = 10) {
  const timer = setTimeout(() => {
    const open = {};
    for (const name of process.getActiveResourcesInfo()) open[name] = (open[name] ?? 0) + 1;
    console.error(`e2e: this process was still alive ${seconds} s after its tests ended; open resources ${JSON.stringify(open)}; ending it`);
    process.exit(process.exitCode ?? 0);
  }, seconds * 1000);
  timer.unref();
}
