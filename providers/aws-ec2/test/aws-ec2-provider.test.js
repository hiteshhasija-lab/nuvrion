import test from 'node:test';
import assert from 'node:assert/strict';
import { AwsEc2Provider, AwsEc2ProviderError } from '../src/aws-ec2-provider.js';
import { defineProviderContract } from '../../test-support/provider-contract.js';

// A fake EC2 SDK. Nothing here talks to AWS: it checks our mapping, pagination, error handling and verification logic.
class Command { constructor(input) { this.input = input; } }
const sdk = {
  DescribeInstancesCommand: class DescribeInstancesCommand extends Command {},
  StartInstancesCommand: class StartInstancesCommand extends Command {},
  StopInstancesCommand: class StopInstancesCommand extends Command {},
  RebootInstancesCommand: class RebootInstancesCommand extends Command {},
  waitUntilInstanceRunning: async () => ({ state: 'SUCCESS' }),
  waitUntilInstanceStopped: async () => ({ state: 'SUCCESS' })
};
const instance = (id, state = 'running', over = {}) => ({
  InstanceId: id, State: { Name: state }, InstanceType: 't3.medium', ImageId: 'ami-1', SubnetId: 'subnet-1', VpcId: 'vpc-1', Architecture: 'x86_64',
  PlatformDetails: 'Linux/UNIX', Placement: { AvailabilityZone: 'us-east-1a' }, CpuOptions: { CoreCount: 2, ThreadsPerCore: 2 },
  NetworkInterfaces: [{ PrivateIpAddresses: [{ PrivateIpAddress: '10.0.0.4' }] }], PublicIpAddress: '3.3.3.3',
  Tags: [{ Key: 'Name', Value: `name-${id}` }, { Key: 'env', Value: 'prod' }], ...over
});

function fakeClient(instances, { pageSize = 1000, fail = null } = {}) {
  const calls = [];
  return {
    calls, instances,
    send: async command => {
      calls.push(command.constructor.name);
      if (fail) throw fail(command);
      if (command instanceof sdk.DescribeInstancesCommand) {
        const start = Number(command.input.NextToken ?? 0), page = instances.slice(start, start + pageSize);
        return { Reservations: [{ Instances: page }], NextToken: start + pageSize < instances.length ? String(start + pageSize) : undefined };
      }
      const state = command instanceof sdk.StopInstancesCommand ? 'stopped' : 'running';
      if (!(command instanceof sdk.RebootInstancesCommand)) for (const id of command.input.InstanceIds) { const found = instances.find(i => i.InstanceId === id); if (found) found.State.Name = state; }
      return { $metadata: { requestId: `req-${calls.length}` } };
    }
  };
}
const providerFor = (instances = [instance('i-1'), instance('i-2', 'stopped')], options) => new AwsEc2Provider({ client: fakeClient(instances, options), sdk, region: 'us-east-1', maxWaitTime: 1 });
const awsError = (name, status, extra = {}) => Object.assign(new Error(`${name} from AWS`), { name, $metadata: { httpStatusCode: status }, ...extra });

defineProviderContract('AwsEc2Provider (fake SDK)', () => providerFor(), { strictReferences: true });

test('discovery maps an instance to the canonical VM shape, including tags, addresses and CPU count', async () => {
  const [vm] = await providerFor([instance('i-abc')]).discover();
  assert.equal(vm.nativeId, 'i-abc');
  assert.equal(vm.name, 'name-i-abc');
  assert.equal(vm.attributes.powerState, 'running');
  assert.equal(vm.attributes.vcpuCount, 4);
  assert.deepEqual(vm.attributes.privateIps, ['10.0.0.4']);
  assert.deepEqual(vm.attributes.publicIps, ['3.3.3.3']);
  assert.equal(vm.attributes.region, 'us-east-1');
  assert.equal(vm.attributes.availabilityZone, 'us-east-1a');
  assert.equal(vm.attributes.providerShape, 't3.medium');
  assert.deepEqual(vm.providerMetadata.tags, { Name: 'name-i-abc', env: 'prod' });
  assert.equal(vm.providerMetadata.vpcId, 'vpc-1');
});

test('an instance with no Name tag is named after its ID, and missing optional fields become null', async () => {
  const [vm] = await providerFor([instance('i-bare', 'stopped', { Tags: [], CpuOptions: undefined, PlatformDetails: undefined, Platform: undefined, PublicIpAddress: undefined, NetworkInterfaces: undefined })]).discover();
  assert.equal(vm.name, 'i-bare');
  assert.equal(vm.attributes.vcpuCount, null);
  assert.equal(vm.attributes.guestOs, null);
  assert.deepEqual(vm.attributes.publicIps, []);
  assert.deepEqual(vm.attributes.privateIps, []);
});

test('discovery follows every page, so large estates are not truncated', async () => {
  const many = Array.from({ length: 7 }, (_, i) => instance(`i-${i}`));
  const client = fakeClient(many, { pageSize: 3 });
  const found = await new AwsEc2Provider({ client, sdk, region: 'us-east-1' }).discover();
  assert.equal(found.length, 7);
  assert.equal(client.calls.length, 3, 'three pages');
});

test('only start, stop and restart are supported; anything else is refused before any request is sent', async () => {
  const client = fakeClient([instance('i-1')]);
  const provider = new AwsEc2Provider({ client, sdk, region: 'us-east-1' });
  for (const operation of ['pause', 'power_off', 'reboot_guest', 'terminate']) {
    await assert.rejects(() => provider.execute(operation, 'i-1'), e => e.code === 'NUV_OPERATION_UNSUPPORTED');
  }
  assert.equal(client.calls.length, 0);
});

test('stop and restart act on the right instance and verification reports the final state', async () => {
  const instances = [instance('i-1')], client = fakeClient(instances), provider = new AwsEc2Provider({ client, sdk, region: 'us-east-1' });
  const stopped = await provider.verify((await provider.execute('stop', 'i-1')).providerReference);
  assert.equal(stopped.observedFinalState, 'stopped');
  assert.equal(instances[0].State.Name, 'stopped');
  const rebooted = await provider.verify((await provider.execute('restart', 'i-1')).providerReference);
  assert.equal(rebooted.observedFinalState, 'running');
  assert.ok(client.calls.includes('RebootInstancesCommand'));
});

test('verification that times out is a retryable error, so the task is left for reconciliation', async () => {
  const provider = new AwsEc2Provider({ client: fakeClient([instance('i-1')]), sdk: { ...sdk, waitUntilInstanceRunning: async () => ({ state: 'TIMEOUT', reason: 'still pending' }) }, region: 'us-east-1' });
  const { providerReference } = await provider.execute('start', 'i-1');
  await assert.rejects(() => provider.verify(providerReference), e => e.code === 'NUV_AWS_VERIFICATION_TIMEOUT' && e.retryable === true && /still pending/.test(e.message));
});

test('AWS errors are mapped to stable codes with the right retry behaviour', async () => {
  const cases = [
    [awsError('AuthFailure', 401), 'NUV_AWS_AUTH_FAILED', false],
    [awsError('UnrecognizedClientException', 403), 'NUV_AWS_AUTH_FAILED', false],
    [awsError('SignatureDoesNotMatch', 403), 'NUV_AWS_AUTH_FAILED', false],
    [awsError('UnauthorizedOperation', 403), 'NUV_AWS_PERMISSION_DENIED', false],
    [awsError('AccessDenied', 403), 'NUV_AWS_PERMISSION_DENIED', false],
    [awsError('InvalidInstanceID.NotFound', 400), 'NUV_AWS_RESOURCE_NOT_FOUND', false],
    [awsError('RequestLimitExceeded', 429), 'NUV_AWS_THROTTLED', true],
    [awsError('Throttling', 400, { $retryable: { throttling: true } }), 'NUV_AWS_THROTTLED', true],
    [awsError('InternalError', 500), 'NUV_AWS_UNAVAILABLE', true],
    [awsError('ServiceUnavailable', 503), 'NUV_AWS_UNAVAILABLE', true],
    [awsError('SomethingElse', 400), 'NUV_AWS_REQUEST_FAILED', false]
  ];
  for (const [error, code, retryable] of cases) {
    const provider = providerFor([instance('i-1')], { fail: () => error });
    await assert.rejects(() => provider.discover(), e => e instanceof AwsEc2ProviderError && e.code === code && e.retryable === retryable, `${error.name} → ${code}`);
  }
});

test('the connection test succeeds against a healthy API and surfaces an authentication failure clearly', async () => {
  assert.deepEqual(await providerFor().testConnection(), { status: 'healthy', provider: 'aws', region: 'us-east-1', api: 'EC2' });
  await assert.rejects(() => providerFor([], { fail: () => awsError('AuthFailure', 401) }).testConnection(), e => e.code === 'NUV_AWS_AUTH_FAILED');
});

test('creating a provider without a region is refused', async () => {
  await assert.rejects(() => AwsEc2Provider.create({ credential: { accessKeyId: 'a', secretAccessKey: 'b' } }), e => e.code === 'NUV_AWS_REGION_REQUIRED');
});

test('an outage on one call does not poison the next: errors carry no stale state', async () => {
  let failing = true;
  const client = fakeClient([instance('i-1')]);
  const send = client.send; client.send = async c => { if (failing) throw awsError('InternalError', 500); return send(c); };
  const provider = new AwsEc2Provider({ client, sdk, region: 'us-east-1' });
  await assert.rejects(() => provider.discover(), e => e.retryable === true);
  failing = false;
  assert.equal((await provider.discover()).length, 1);
});
