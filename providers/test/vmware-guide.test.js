import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// docs/vmware-setup.md promises that its privilege table covers every vSphere call the VMware adapters make and explains every error they raise. These
// tests read the adapters' source, so a new call or code that nobody wrote up fails here and not on a customer's host.
const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const SOURCES = ['providers/vmware-esxi/src/esxi-provider.js', 'providers/vmware-vsphere/src/vsphere-provider.js', 'providers/vmware-vsphere/src/vsphere-quickstats.js',
  'providers/vmware-snapshots.js', 'providers/vmware-settings.js', 'providers/vmware-media.js', 'providers/vmware-workstation/src/workstation-provider.js',
  'providers/vmware-workstation-agent/src/workstation-agent-provider.js', 'providers/tls-trust.js'];
const unique = list => [...new Set(list)].sort();
const sources = () => Promise.all(SOURCES.map(read)).then(parts => parts.join('\n'));

test('every vSphere SOAP method the adapters call is in the guide', async () => {
  const code = await sources(), guide = await read('docs/vmware-setup.md');
  const methods = unique([...code.matchAll(/<vim25:([A-Z][A-Za-z]+(?:_Task)?)>/g)].map(match => match[1]).concat([...code.matchAll(/'([A-Z][A-Za-z]+_Task)'/g)].map(match => match[1])));
  assert.ok(methods.length >= 15, `expected to find the SOAP methods, found ${methods.join(', ')}`);
  const missing = methods.filter(name => !guide.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `docs/vmware-setup.md does not list ${missing.join(', ')}: add it to the table and say which privilege it needs`);
});

test('every vCenter REST path the adapter calls is in the guide', async () => {
  const code = await read('providers/vmware-vsphere/src/vsphere-provider.js'), guide = await read('docs/vmware-setup.md');
  const paths = unique([...code.matchAll(/['`](\/api\/[A-Za-z0-9_/${}.\-]*)(?:\?[^'`]*)?['`]/g)].map(match => match[1].replace(/\$\{[^}]*\}/g, '{id}')).filter(path => !/^\/api\/vcenter\/\{id\}(\{id\})?$/.test(path)));
  assert.ok(paths.includes('/api/session') && paths.includes('/api/vcenter/vm/{id}/power'), paths.join(', '));
  const missing = paths.filter(path => !guide.includes(`\`${path}\``));
  assert.deepEqual(missing, [], `docs/vmware-setup.md does not list ${missing.join(', ')}`);
});

test('the privilege file and the guide agree, and nothing is a wildcard', async () => {
  const file = JSON.parse(await read('docs/policies/vmware-nuvrion-privileges.json')), guide = await read('docs/vmware-setup.md');
  const all = Object.values(file.groups).flat();
  assert.deepEqual(Object.keys(file.groups).sort(), ['console', 'media', 'power', 'read', 'settings', 'snapshots']);
  assert.ok(all.every(id => /^[A-Za-z]+(\.[A-Za-z]+)+$/.test(id)), 'privilege ids look like Group.Subgroup.Name');
  assert.equal(all.length, new Set(all).size, 'a privilege is listed twice');
  const missing = all.filter(id => !guide.includes(`\`${id}\``));
  assert.deepEqual(missing, [], `docs/vmware-setup.md does not name ${missing.join(', ')}`);
  assert.ok(guide.includes('policies/vmware-nuvrion-privileges.json'));
});

test('every error code the adapters raise is explained in the guide', async () => {
  const code = await sources(), guide = await read('docs/vmware-setup.md');
  const succeeded = /_(VERIFIED|MOUNTED|EJECTED|CREATED|DELETED|REVERTED|UPDATED|UNCHANGED)$/;
  const raised = unique([...code.matchAll(/'(NUV_[A-Z_]+)'/g)].map(match => match[1]).filter(name => !succeeded.test(name)));
  assert.ok(raised.length > 60, `expected the VMware codes, found ${raised.length}`);
  const missing = raised.filter(name => !guide.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `docs/vmware-setup.md does not explain ${missing.join(', ')}`);
});
