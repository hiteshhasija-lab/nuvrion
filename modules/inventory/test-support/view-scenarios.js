// The behaviour both saved-view stores (the local file and PostgreSQL) must have, written once. Not a test file itself.
import assert from 'node:assert/strict';
import { LIMITS } from '../src/view-rules.js';

export const T0 = Date.parse('2026-10-23T10:00:00Z');
const refused = (promise, code) => assert.rejects(promise, error => error.code === code || error.message === code, code);
const web = { search: 'web', platform: 'vmware_esxi', power: 'running', sortKey: 'memory', sortDirection: 'desc' };

// ctx: { service, time, ann, bob } where ann and bob are two people (ids)
export const scenarios = {
  async 'a view is created, listed and fetched with its filters and a version, by name order'(ctx) {
    const { service, ann, time } = ctx;
    const created = await service.createView(ann, { name: 'Web servers', view: web });
    assert.deepEqual([created.name, created.scope, created.rowVersion, created.view, created.createdAt], ['Web servers', 'inventory', 1, { search: 'web', platform: 'vmware_esxi', power: 'running', health: null, tag: null, sortKey: 'memory', sortDirection: 'desc' }, new Date(time.now).toISOString()]);
    assert.equal('userId' in created, false, 'no owner in what is returned');
    await service.createView(ann, { name: 'All running', view: { power: 'running' } });
    assert.deepEqual((await service.listViews(ann)).map(item => item.name), ['All running', 'Web servers']);
    assert.deepEqual((await service.getView(ann, created.id)).view.search, 'web');
    assert.equal(await service.getView(ann, '00000000-0000-4000-8000-000000000001'), null); assert.equal(await service.getView(ann, 'not-an-id'), null);
  },
  async 'a person sees and changes only their own views, and two people may use the same name'(ctx) {
    const { service, ann, bob } = ctx;
    const mine = await service.createView(ann, { name: 'Shared name', view: web });
    assert.deepEqual(await service.listViews(bob), []);
    assert.equal(await service.getView(bob, mine.id), null);
    assert.equal(await service.updateView(bob, mine.id, { name: 'Stolen' }, 1), null);
    assert.equal(await service.deleteView(bob, mine.id), null);
    const theirs = await service.createView(bob, { name: 'shared NAME', view: {} });
    assert.equal(theirs.name, 'shared NAME');
    assert.equal((await service.getView(ann, mine.id)).name, 'Shared name', 'untouched');
  },
  async 'a name is unique for a person whatever the case, and a person may keep at most twenty views'(ctx) {
    const { service, ann } = ctx;
    await service.createView(ann, { name: 'Prod', view: {} });
    await refused(service.createView(ann, { name: 'prod', view: {} }), 'NUV_VIEW_EXISTS');
    await refused(service.createView(ann, { name: '', view: {} }), 'NUV_VIEW_INVALID');
    await refused(service.createView(ann, { name: 'Bad', view: { sortKey: 'color' } }), 'NUV_VIEW_INVALID');
    for (let i = 1; i < LIMITS.perPerson; i++) await service.createView(ann, { name: `View ${i}`, view: {} });
    await refused(service.createView(ann, { name: 'One too many', view: {} }), 'NUV_VIEW_LIMIT');
    assert.equal((await service.listViews(ann)).length, LIMITS.perPerson);
  },
  async 'a view is renamed or re-saved with the current version, and a stale version, a name clash and a missing view are refused'(ctx) {
    const { service, ann, time } = ctx;
    const created = await service.createView(ann, { name: 'Old name', view: web });
    time.now += 60_000;
    const renamed = await service.updateView(ann, created.id, { name: 'New name' }, 1);
    assert.deepEqual([renamed.name, renamed.rowVersion, renamed.view.search, renamed.updatedAt > created.updatedAt], ['New name', 2, 'web', true]);
    const resaved = await service.updateView(ann, created.id, { view: { power: 'stopped' } }, 2);
    assert.deepEqual([resaved.name, resaved.rowVersion, resaved.view.power, resaved.view.search], ['New name', 3, 'stopped', '']);
    await assert.rejects(service.updateView(ann, created.id, { name: 'Stale' }, 1), /VERSION_CONFLICT/);
    await service.createView(ann, { name: 'Other', view: {} });
    await refused(service.updateView(ann, created.id, { name: 'OTHER' }, 3), 'NUV_VIEW_EXISTS');
    await refused(service.updateView(ann, created.id, { view: { sortKey: 'x' } }, 3), 'NUV_VIEW_INVALID');
    await refused(service.updateView(ann, created.id, {}, 3), 'NUV_VIEW_INVALID');
    assert.equal(await service.updateView(ann, '00000000-0000-4000-8000-000000000001', { name: 'x' }, 1), null);
    assert.equal((await service.getView(ann, created.id)).rowVersion, 3);
  },
  async 'a view is deleted once'(ctx) {
    const { service, ann } = ctx;
    const created = await service.createView(ann, { name: 'Temporary', view: {} });
    assert.deepEqual(await service.deleteView(ann, created.id), { deleted: 1 });
    assert.equal(await service.deleteView(ann, created.id), null); assert.equal(await service.deleteView(ann, 'not-an-id'), null);
    assert.deepEqual(await service.listViews(ann), []);
  }
};
