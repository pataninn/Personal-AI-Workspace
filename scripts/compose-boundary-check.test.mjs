import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const composePath = new URL('../compose.yaml', import.meta.url);
const source = readFileSync(composePath, 'utf8');

function service(name) {
  const pattern = new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\r?$|^networks:|^volumes:|^secrets:)`, 'm');
  const match = pattern.exec(source);
  assert.ok(match, `Compose service ${name} must exist`);
  return match[1];
}

test('Compose contains only the MVP1 app and private PostgreSQL services', () => {
  const serviceSection = source.split(/^networks:\r?$/m, 1)[0];
  const names = [...serviceSection.matchAll(/^  ([a-z][a-z0-9-]*):\r?$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(names.sort(), ['personal-ai-app', 'postgres']);
  assert.match(source, /app-data:\r?\n    internal: true/);
  assert.match(source, /provider-egress:\r?\n    internal: false/);
  assert.match(source, /pai_pg_data:/);
  assert.match(source, /pai_recovery:/);
  assert.doesNotMatch(source, /openshell|staging/i);
});

test('only the app publishes a loopback port and owns the workspace bind', () => {
  const app = service('personal-ai-app');
  assert.match(app, /127\.0\.0\.1:\$\{APP_PORT/);
  assert.match(app, /source: \$\{WORKSPACE_HOST_ROOT/);
  assert.match(app, /target: \/workspace/);
  assert.match(app, /target: \/run\/tls\r?\n        read_only: true/);
  assert.doesNotMatch(service('postgres'), /ports:/);
  assert.doesNotMatch(service('postgres'), /target: \/workspace/);
  assert.equal((source.match(/^[ ]{4}ports:\r?$/gm) ?? []).length, 1);
});

test('provider egress and recovery are app-only boundaries', () => {
  const app = service('personal-ai-app');
  const postgres = service('postgres');
  assert.match(app, /networks:\r?\n      - app-data\r?\n      - provider-egress/);
  assert.match(postgres, /networks:\r?\n      - app-data/);
  assert.doesNotMatch(postgres, /provider-egress/);
  assert.match(app, /source: pai_recovery\r?\n        target: \/var\/lib\/personal-ai\/recovery/);
  assert.doesNotMatch(app, /pai_staging|STAGING_ROOT/);
  assert.doesNotMatch(postgres, /NVIDIA|nvidia/i);
});

test('the NVIDIA key is a read-only Docker secret visible only to the app', () => {
  const app = service('personal-ai-app');
  const postgres = service('postgres');
  assert.match(app, /    secrets:[\s\S]*?      - source: nvidia_api_key/);
  assert.match(app, /target: nvidia_api_key[\s\S]*?mode: 0440/);
  assert.match(app, /NVIDIA_API_KEY_FILE: \/run\/secrets\/nvidia_api_key/);
  assert.match(source, /^secrets:[\s\S]*?^  nvidia_api_key:\r?\n    file: \$\{NVIDIA_API_KEY_FILE/m);
  assert.doesNotMatch(postgres, /secrets:|NVIDIA_API_KEY_FILE|nvidia_api_key/i);
  assert.doesNotMatch(source, /NVIDIA_API_KEY:\s*\$/);
});

test('the local login password is a read-only Docker secret visible only to the app', () => {
  const app = service('personal-ai-app');
  const postgres = service('postgres');
  assert.match(app, /LOCAL_USER_PASSWORD_FILE: \/run\/secrets\/local_user_password/);
  assert.match(app, /    secrets:[\s\S]*?      - source: local_user_password/);
  assert.match(app, /target: local_user_password[\s\S]*?mode: 0440/);
  assert.match(source, /local_user_password:\r?\n    file: \$\{LOCAL_USER_PASSWORD_FILE:-\.\/secrets\/local_user_password\}/);
  assert.doesNotMatch(postgres, /secrets:|LOCAL_USER_PASSWORD|local_user_password/i);
  assert.doesNotMatch(source, /LOCAL_USER_PASSWORD:\s*\$\{/);
});

test('app has a read-only root, no runtime socket, and non-root defaults', () => {
  const app = service('personal-ai-app');
  assert.match(app, /    read_only: true/);
  assert.match(app, /    user: "10001:10001"/);
  assert.match(app, /      - no-new-privileges:true/);
  assert.match(app, /      - ALL/);
  assert.doesNotMatch(source, /docker\.sock|privileged:\s*true/);
});

test('app performs ordered migrations after PostgreSQL health', () => {
  const app = service('personal-ai-app');
  assert.match(app, /node backend\/dist\/infrastructure\/database\/migrate\.js/);
  assert.match(app, /exec node backend\/dist\/server\.js/);
  assert.match(app, /depends_on:\r?\n      postgres:\r?\n        condition: service_healthy/);
});
