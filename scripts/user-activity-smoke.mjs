// Native protocol/lifetime checks only. This never posts input or changes apps.
// Run after npm run build:native: node scripts/user-activity-smoke.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

if (process.platform !== 'darwin') {
  console.log('Skipped: user-activity monitor requires macOS.');
  process.exit(0);
}
const binary = fileURLToPath(new URL('../.local/bin/flick-user-activity', import.meta.url));
const classification = spawnSync(binary, ['--self-test'], { encoding: 'utf8' });
assert.equal(classification.status, 0, classification.stderr || classification.error?.message);
assert.deepEqual(JSON.parse(classification.stdout), { passed: true, type: 'self-test' });
const permission = spawnSync(binary, ['--check'], { encoding: 'utf8' });
const permissionResult = JSON.parse(permission.stdout);
assert.equal(permissionResult.type, 'check');
assert.equal(permissionResult.available, permission.status === 0);
if (!permissionResult.available) {
  const denied = spawnSync(binary, [], { encoding: 'utf8', input: '', timeout: 3_000 });
  assert.equal(denied.status, 2);
  assert.equal(JSON.parse(denied.stdout).code, 'permission_required');
  console.log('Classification and denied-permission protocol pass; no permission requested.');
  process.exit(0);
}

for (const ending of ['eof', 'signal']) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let ready = false;
    let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${ending}: monitor did not stop`)); }, 3_000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'ready') {
          assert.equal(ready, false);
          ready = true;
          assert.equal(event.physicalInputOnly, true);
          if (ending === 'eof') child.stdin.end();
          else child.kill('SIGTERM');
        } else if (event.type === 'activity') {
          // A person may move the mouse during this passive check. Only event
          // category/time may appear; key values or pointer positions may not.
          assert.deepEqual(Object.keys(event).sort(), ['kind', 'timestamp', 'type']);
          assert.ok(['mouse', 'keyboard', 'scroll'].includes(event.kind));
        } else throw new Error(`Unexpected monitor message: ${event.type}`);
      } catch (error) { clearTimeout(timeout); child.kill('SIGKILL'); reject(error); }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      try {
        assert.equal(ready, true);
        assert.equal(code, 0, stderr || `${ending}: exited with ${signal}`);
        assert.equal(stderr, '');
        resolve();
      } catch (error) { reject(error); }
    });
  });
}
console.log('User-activity classification, permission preflight, stdin EOF, and SIGTERM checks pass.');
