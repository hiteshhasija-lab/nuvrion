import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The only route that turns part of the URL into a file path is the noVNC static route. This pins the review of it (static analysis flags the read, and the
// answer to "can the URL leave the vendor directory" is the guard in front of it): every traversal spelling is a 404, and the intended file is served.
describe('the noVNC static route does not leave its directory', () => {
  let server, base, workDir;
  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'nuvrion-static-paths-'));
    Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_TAGS_FILE: join(workDir, 'tags.json'),
      NUVRION_UPGRADE_SHARED_DIR: join(workDir, 'upgrades'), NUVRION_BOOTSTRAP_PASSWORD: 'Static-Paths-Password-1!' }); // secret-scan:allow (fake test credential)
    delete process.env.NUVRION_RUNTIME_PROFILE;
    const { createServer } = await import('../src/server.js');
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise(resolve => server?.close(resolve)); server?.closeAllConnections?.(); rmSync(workDir, { recursive: true, force: true }); });

  test('the intended script is served', async () => {
    const response = await fetch(`${base}/vendor/novnc/core/rfb.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(await response.text(), /noVNC/);
  });

  test('every way of climbing out of the directory, or naming an absolute or non-script path, is a 404 with no file content', async () => {
    const attempts = ['/vendor/novnc/../../../package.json', '/vendor/novnc/%2e%2e/%2e%2e/package.json', '/vendor/novnc/..%2f..%2fpackage.json',
      '/vendor/novnc/core/../../server.js', '/vendor/novnc//etc/passwd.js', '/vendor/novnc/%2fetc%2fpasswd.js', '/vendor/novnc/core/rfb.js%00.png',
      '/vendor/novnc/.%2e/.%2e/package.json', '/vendor/novnc/core/rfb.json', '/vendor/novnc/', '/vendor/novnc/core', '/vendor/novnc/core/'];
    for (const path of attempts) {
      const response = await fetch(`${base}${path}`);
      const body = await response.text();
      assert.equal(response.status, 404, path);
      assert.doesNotMatch(body, /"name":\s*"nuvrion"|root:|createServer/, `${path} must not return file content`);
    }
  });
});
