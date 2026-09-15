import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const composePath = new URL('../compose.yaml', import.meta.url);
const source = readFileSync(composePath, 'utf8');

function service(name) {
  const pattern = new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\r?$)`, 'm');
  const match = pattern.exec(source);
  assert.ok(match, `Compose service ${name} must exist`);
  return match[1];
}

test('Compose defines the foundation service graph and private boundaries', () => {
  const names = [...source.matchAll(/^  ([a-z][a-z0-9-]*):\r?$/gm)]
    .map((match) => match[1])
    .filter((name) => ['postgres', 'migrate', 'openshell-gateway', 'personal-ai-app'].includes(name));
  assert.deepEqual(names.sort(), [
    'migrate',
    'openshell-gateway',
    'personal-ai-app',
    'postgres'
  ]);
  assert.match(source, /app-data:\r?\n    internal: true/);
  assert.match(source, /sandbox-control:\r?\n    internal: true/);
  assert.match(source, /gateway-egress:\r?\n    internal: false/);
  for (const volume of ['pai_logs', 'pai_openshell_state', 'pai_pg_data', 'pai_recovery', 'pai_staging']) {
    assert.match(source, new RegExp(`^  ${volume}:`, 'm'));
  }
});

test('only the app publishes a loopback port and owns the workspace bind', () => {
  const app = service('personal-ai-app');
  assert.equal((app.match(/^    ports:$/gm) ?? []).length, 1);
  assert.match(app, /127\.0\.0\.1:\$\{APP_PORT/);
  assert.match(app, /target: \/workspace/);
  for (const name of ['postgres', 'openshell-gateway', 'migrate']) {
    assert.equal(service(name).includes('    ports:'), false, `${name} cannot publish ports`);
  }
});

test('gateway and database cannot receive the authoritative workspace or runtime socket', () => {
  assert.equal(source.includes('docker.sock'), false);
  for (const name of ['postgres', 'migrate', 'openshell-gateway']) {
    assert.equal(service(name).includes('target: /workspace'), false, `${name} cannot mount /workspace`);
  }
  assert.equal(service('openshell-gateway').includes('      - app-data'), false);
  assert.match(service('openshell-gateway'), /    secrets:\r?\n      - nvidia_api_key/);
  assert.equal(service('personal-ai-app').includes('    secrets:'), false);
});

test('app and gateway use non-root, no-new-privileges defaults', () => {
  for (const name of ['personal-ai-app', 'openshell-gateway']) {
    const current = service(name);
    assert.match(current, /    user: "10001:10001"/);
    assert.match(current, /      - no-new-privileges:true/);
    assert.match(current, /      - ALL/);
  }
  assert.match(service('personal-ai-app'), /    read_only: true/);
});
