import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyGuestOs } from '../src/workstation-agent-provider.js';

// Real values reported by the lab's Workstation agent, and what they should read as in the UI.
const reported = [
  ['rhel10-64', 'Red Hat Enterprise Linux 10 (64-bit)'],
  ['rhel9-64', 'Red Hat Enterprise Linux 9 (64-bit)'],
  ['rhel5', 'Red Hat Enterprise Linux 5'],
  ['vmkernel7', 'VMware ESXi 7.0.2'],
  ['vmkernel8', 'VMware ESXi 8.x'],
  ["architecture='X86' bitness='64' distroName='VMkernel' familyName='VMkernel' kernelVersion='8.0.3'", 'VMware ESXi 8.0.3'],
  ['windows9srv-64', 'Microsoft Windows Server 2016 (64-bit)'],
  ['windows2019srv-64', 'Microsoft Windows Server 2019 (64-bit)'],
  ['windows7-64', 'Microsoft Windows 7 (64-bit)'],
  ['winnetenterprise', 'Microsoft Windows Server 2003 Enterprise'],
  ['win2000serv', 'Microsoft Windows 2000 Server'],
  ['win2000advserv', 'Microsoft Windows 2000 Advanced Server'],
  ['longhorn-64', 'Microsoft Windows Server 2008 (64-bit)'],
  ['other5xlinux', 'Other Linux 5.x kernel'],
  ['dos', 'MS-DOS']
];

for (const [code, expected] of reported) {
  test(`${code.length > 40 ? code.slice(0, 37) + '...' : code} reads as "${expected}"`, () => {
    assert.equal(friendlyGuestOs(code), expected);
  });
}

test('any rhelN code is named even when N is not in the table', () => {
  assert.equal(friendlyGuestOs('rhel11-64'), 'Red Hat Enterprise Linux 11 (64-bit)');
  assert.equal(friendlyGuestOs('rhel4'), 'Red Hat Enterprise Linux 4');
});

test('matching ignores case and surrounding whitespace', () => {
  assert.equal(friendlyGuestOs('  RHEL10-64 '), 'Red Hat Enterprise Linux 10 (64-bit)');
  assert.equal(friendlyGuestOs('VMkernel8'), 'VMware ESXi 8.x');
});

test('names the guest itself reported are shown unchanged', () => {
  for (const name of ['Windows Server 2016, 64-bit (Build 14393.3686)', 'Microsoft Windows Server 2012 (64-bit)']) {
    assert.equal(friendlyGuestOs(name), name);
  }
});

test('unknown codes pass through unchanged rather than being guessed at', () => {
  assert.equal(friendlyGuestOs('solaris11-64'), 'solaris11-64');
});

test('missing values become null so the UI can show Unknown', () => {
  assert.equal(friendlyGuestOs(null), null);
  assert.equal(friendlyGuestOs(undefined), null);
  assert.equal(friendlyGuestOs(''), null);
  assert.equal(friendlyGuestOs('   '), null);
});

test('a VMkernel detail string without a version still reads as ESXi', () => {
  assert.equal(friendlyGuestOs("distroName='VMkernel' familyName='VMkernel'"), 'VMware ESXi');
});
