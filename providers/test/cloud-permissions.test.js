import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// docs/aws-setup.md and docs/azure-setup.md promise a least-privilege policy: exactly the calls the adapters make. These tests read the
// adapters' source, so a new SDK call that is not in the policy and the guide fails here instead of failing on a customer's account.
const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

// What each SDK call needs. A call that is missing from this table is a call nobody has written the permission for.
const AWS_ACTIONS = {
  DescribeInstancesCommand: 'ec2:DescribeInstances',
  StartInstancesCommand: 'ec2:StartInstances',
  StopInstancesCommand: 'ec2:StopInstances',
  RebootInstancesCommand: 'ec2:RebootInstances',
  waitUntilInstanceRunning: 'ec2:DescribeInstances',
  waitUntilInstanceStopped: 'ec2:DescribeInstances'
};
const AZURE_ACTIONS = {
  listAll: 'Microsoft.Compute/virtualMachines/read',
  instanceView: 'Microsoft.Compute/virtualMachines/instanceView/read',
  beginStartAndWait: 'Microsoft.Compute/virtualMachines/start/action',
  beginDeallocateAndWait: 'Microsoft.Compute/virtualMachines/deallocate/action',
  beginRestartAndWait: 'Microsoft.Compute/virtualMachines/restart/action'
};
// Polled by the long-running calls, never named in the adapter.
const AZURE_IMPLICIT = ['Microsoft.Compute/locations/operations/read'];

const unique = list => [...new Set(list)].sort();

test('the AWS policy allows exactly the EC2 calls the adapter makes', async () => {
  const source = await read('providers/aws-ec2/src/aws-ec2-provider.js');
  const used = unique([...source.matchAll(/\b(\w+Command|waitUntil\w+)\b/g)].map(match => match[1]).filter(name => name !== 'Command'));
  const unknown = used.filter(name => !(name in AWS_ACTIONS));
  assert.deepEqual(unknown, [], `the AWS adapter uses ${unknown.join(', ')}: add the permission to docs/policies/aws-nuvrion-iam-policy.json and docs/aws-setup.md, then to AWS_ACTIONS in this test`);
  const policy = JSON.parse(await read('docs/policies/aws-nuvrion-iam-policy.json'));
  const allowed = unique(policy.Statement.flatMap(statement => [statement.Action].flat()));
  assert.deepEqual(allowed, unique(used.map(name => AWS_ACTIONS[name])));
  for (const statement of policy.Statement) assert.equal(statement.Effect, 'Allow');
});

test('the AWS policy does not let the power actions touch anything but instances', async () => {
  const policy = JSON.parse(await read('docs/policies/aws-nuvrion-iam-policy.json'));
  const power = policy.Statement.find(statement => [statement.Action].flat().includes('ec2:StopInstances'));
  assert.equal(power.Resource, 'arn:aws:ec2:*:*:instance/*');
  assert.ok(![power.Action].flat().includes('ec2:DescribeInstances'), 'the read permission has to stay in its own statement: it cannot be scoped');
});

test('the Azure role allows exactly the Compute calls the adapter makes', async () => {
  const source = await read('providers/azure-vm/src/azure-vm-provider.js');
  const used = unique([...source.matchAll(/\bvirtualMachines\.(\w+)\(/g)].map(match => match[1]));
  const named = unique([...source.matchAll(/'(begin\w+AndWait)'/g)].map(match => match[1]));
  const calls = unique([...used, ...named]);
  const unknown = calls.filter(name => !(name in AZURE_ACTIONS));
  assert.deepEqual(unknown, [], `the Azure adapter uses ${unknown.join(', ')}: add the permission to docs/policies/azure-nuvrion-role.json and docs/azure-setup.md, then to AZURE_ACTIONS in this test`);
  assert.ok(named.length === 3, 'the start, stop and restart methods are expected to be named in the adapter');
  const role = JSON.parse(await read('docs/policies/azure-nuvrion-role.json'));
  assert.deepEqual(unique(role.Actions), unique([...calls.map(name => AZURE_ACTIONS[name]), ...AZURE_IMPLICIT]));
  assert.deepEqual(role.NotActions, []);
  assert.deepEqual(role.DataActions, [], 'Nuvrion reads and operates machines through the control plane only');
  assert.ok(role.Actions.every(action => action.startsWith('Microsoft.Compute/')));
  assert.ok(role.Actions.every(action => !action.includes('*')), 'no wildcard action in a least-privilege role');
});

test('each guide shows its policy as the file holds it, and names every permission', async () => {
  for (const [guide, file, hint] of [['docs/aws-setup.md', 'docs/policies/aws-nuvrion-iam-policy.json', 'Action'], ['docs/azure-setup.md', 'docs/policies/azure-nuvrion-role.json', 'Actions']]) {
    const text = await read(guide);
    const policy = JSON.parse(await read(file));
    const fence = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => match[1]).find(body => body.includes(`"${hint}"`) && body.includes('"Version"') === (hint === 'Action'));
    assert.ok(fence, `${guide} has to show the policy in a json block`);
    assert.deepEqual(JSON.parse(fence), policy, `${guide} shows a policy that differs from ${file}: copy the file into the guide`);
    assert.ok(text.includes(file.replace('docs/', '')), `${guide} has to link ${file}`);
  }
});

test('each guide documents every error code its adapter can raise', async () => {
  for (const [guide, source, prefix] of [['docs/aws-setup.md', 'providers/aws-ec2/src/aws-ec2-provider.js', 'NUV_AWS_'], ['docs/azure-setup.md', 'providers/azure-vm/src/azure-vm-provider.js', 'NUV_AZURE_']]) {
    const text = await read(guide);
    const raised = unique([...(await read(source)).matchAll(new RegExp(`'(${prefix}[A-Z_]+)'`, 'g'))].map(match => match[1]));
    const missing = raised.filter(code => !text.includes(`\`${code}\``) && !['NUV_AWS_REFERENCE_INVALID', 'NUV_AZURE_REFERENCE_INVALID'].includes(code));
    assert.deepEqual(missing, [], `${guide} does not explain ${missing.join(', ')}`);
  }
});
