import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViewService } from '../src/view-service.js';
import { scenarios, T0 } from '../test-support/view-scenarios.js';

// The local saved-view store: the behaviour every store has (test-support/view-scenarios.js), plus that views survive a restart.
const ANN = '11111111-1111-4111-8111-111111111111', BOB = '22222222-2222-4222-8222-222222222222';
for (const [name, run] of Object.entries(scenarios)) {
  test(name, async () => { const time = { now: T0 }; await run({ service: new ViewService({ clock: () => time.now }), time, ann: ANN, bob: BOB }); });
}
test('views survive a restart, and a damaged file starts a new set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-views-')), file = join(dir, 'views.json');
  try {
    const first = new ViewService({ file, clock: () => T0 });
    await first.createView(ANN, { name: 'Kept', view: { search: 'db' } });
    assert.deepEqual((await new ViewService({ file }).listViews(ANN)).map(item => item.name), ['Kept']);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, '{ nope');
    assert.deepEqual(await new ViewService({ file }).listViews(ANN), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
