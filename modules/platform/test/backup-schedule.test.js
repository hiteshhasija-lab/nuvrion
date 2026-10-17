import test from 'node:test';
import assert from 'node:assert/strict';
import { launchAgentPlist, LAUNCH_LABEL } from '../src/backup-schedule.js';

const options = { node: '/opt/homebrew/bin/node', script: '/Users/a b/Nuvrion/tools/backup.js', workingDirectory: '/Users/a b/Nuvrion', path: '/opt/homebrew/bin:/usr/bin', log: '/Users/a b/Library/Logs/x.log' };

test('the launchd job runs `backup.js pull` every hour and at load, with absolute paths and a PATH that finds openssl and rsync', () => {
  const plist = launchAgentPlist(options);
  assert.match(plist, new RegExp(`<key>Label</key><string>${LAUNCH_LABEL}</string>`));
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string><string>\/Users\/a b\/Nuvrion\/tools\/backup\.js<\/string><string>pull<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>3600<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
});

test('values are escaped for XML, relative paths and silly intervals are refused', () => {
  assert.match(launchAgentPlist({ ...options, path: '/a&b:/c<d' }), /\/a&amp;b:\/c&lt;d/);
  assert.throws(() => launchAgentPlist({ ...options, node: 'node' }), /absolute/);
  assert.throws(() => launchAgentPlist({ ...options, log: 'x.log' }), /absolute/);
  assert.throws(() => launchAgentPlist({ ...options, intervalSeconds: 10 }), /5 minutes/);
});
