import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DestinationService } from '../src/destination-service.js';
import { scenarios, T0 } from '../test-support/store-scenarios.js';

// The local webhook store: the behaviour every store has (test-support/store-scenarios.js), plus what is particular to a file: the address is not in it as written, it survives a restart.
const make = () => { const dir = mkdtempSync(join(tmpdir(), 'nuvrion-webhooks-')), time = { now: T0 }, file = join(dir, 'webhooks.json'); return { dir, file, time, service: new DestinationService({ file, clock: () => time.now }) }; };
for (const [name, run] of Object.entries(scenarios())) {
  test(name, async () => { const ctx = make(); try { await run(ctx); } finally { rmSync(ctx.dir, { recursive: true, force: true }); } });
}

test('the file holds the address sealed, not as written, and a restart finds the webhook and can still open it', async () => {
  const ctx = make();
  try {
    const created = await ctx.service.createDestination({ name: 'Ops', url: 'https://hooks.example.com/services/very-secret-token', signingSecret: 'a-long-signing-secret' }, 'user-1');   // secret-scan:allow (fake test credential)
    const text = readFileSync(ctx.file, 'utf8');
    assert.equal(text.includes('very-secret-token') || text.includes('a-long-signing-secret'), false);
    const again = new DestinationService({ file: ctx.file, clock: () => ctx.time.now });
    assert.deepEqual((await again.listDestinations()).map(item => item.name), ['Ops']);
    assert.deepEqual(await again.secretsOf(created.id), { url: 'https://hooks.example.com/services/very-secret-token', signingSecret: 'a-long-signing-secret' });   // secret-scan:allow (fake test credential)
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('a sealed address cannot be moved to another webhook: it is bound to the webhook it was sealed for', async () => {
  const ctx = make();
  try {
    const a = await ctx.service.createDestination({ name: 'A', url: 'https://a.example.com/x' }, null), b = await ctx.service.createDestination({ name: 'B', url: 'https://b.example.com/y' }, null);
    const saved = JSON.parse(readFileSync(ctx.file, 'utf8'));
    const [first, second] = saved.destinations;
    const swapped = { ...saved, destinations: [{ ...first, secret: second.secret }, { ...second, secret: first.secret }] };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(ctx.file, JSON.stringify(swapped));
    const tampered = new DestinationService({ file: ctx.file, clock: () => ctx.time.now });
    await assert.rejects(tampered.secretsOf(a.id)); await assert.rejects(tampered.secretsOf(b.id));
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});
