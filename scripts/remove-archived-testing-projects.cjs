/* Operator-only cleanup explicitly authorized for the archived testing projects.
 * Run inside the app container: node script.cjs --remove-archived-testing
 * Uses the normal authenticated/versioned API; never removes project folders.
 */
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function fingerprint(root) {
  const hash = createHash('sha256');
  let entries = 0;
  async function visit(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      if (++entries > 100000) throw Error('Project fingerprint exceeds the cleanup bound.');
      const target = path.join(directory, name);
      const stat = await fs.lstat(target);
      hash.update(path.relative(root, target));
      if (stat.isSymbolicLink()) hash.update(await fs.readlink(target));
      else if (stat.isDirectory()) await visit(target);
      else if (stat.isFile()) hash.update(await fs.readFile(target));
      else throw Error('Unexpected project entry.');
    }
  }
  try { await visit(root); return { exists: true, entries, digest: hash.digest('hex') }; }
  catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
}

async function main() {
  assert.equal(process.argv[2], '--remove-archived-testing');
  const origin = process.env.APP_ORIGIN;
  const appUrl = new URL(origin);
  assert.equal(appUrl.protocol, 'https:');
  assert.equal(appUrl.hostname, '127.0.0.1');
  let cookie, csrf;
  async function request(method, resource, body, headers = {}) {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = https.request(new URL(resource, origin), { method, rejectUnauthorized: false, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...headers } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }); });
      });
      req.on('error', reject); req.end(bytes);
    });
  }
  const login = await request('POST', '/api/v1/auth/login', { password: (await fs.readFile(process.env.LOCAL_USER_PASSWORD_FILE, 'utf8')).trimEnd() });
  assert.equal(login.status, 200);
  cookie = login.headers['set-cookie'][0].split(';')[0]; csrf = login.body.data.csrfToken;
  const report = { removed: [], blocked: [], foldersPreserved: true, providerCalls: 0 };
  try {
    const list = await request('GET', '/api/v1/projects'); assert.equal(list.status, 200);
    const projects = list.body.data.projects.filter((project) => project.status === 'archived');
    // This old test consent never started a run. Reject through the normal API.
    if (projects.some((project) => project.id === 'c8c0c303-3761-4f4c-9013-76b6485439d9')) {
      const runId = '78795ed5-a131-40eb-ad42-2ad9ab740e83';
      const run = await request('GET', `/api/v1/ai-runs/${runId}`);
      if (run.status === 200 && run.body.data.status === 'pending_approval') {
        const manifest = await request('GET', `/api/v1/ai-runs/${runId}/egress-manifest`);
        assert.equal(manifest.status, 200);
        const rejected = await request('POST', `/api/v1/ai-runs/${runId}/egress-decision`, { decision: 'reject', manifestHash: manifest.body.data.manifestHash }, { 'Idempotency-Key': 'redesign-archive-consent-rejection' });
        assert.equal(rejected.status, 200);
        process.stdout.write(JSON.stringify({ runId, consentRejected: true, providerCalls: 0 }) + '\n');
      }
    }
    const workspace = path.resolve(process.env.WORKSPACE_ROOT);
    for (const project of projects) {
      const root = path.resolve(workspace, project.relativeRoot);
      assert(root === workspace || root.startsWith(workspace + path.sep));
      const before = await fingerprint(root);
      const result = await request('DELETE', `/api/v1/projects/${project.id}`, undefined, { 'If-Match': String(project.version) });
      if (result.status === 204) report.removed.push({ id: project.id, name: project.name, relativeRoot: project.relativeRoot });
      else report.blocked.push({ id: project.id, name: project.name, status: result.status, code: result.body?.error?.code });
      assert.deepEqual(await fingerprint(root), before, 'Project folder changed during application-data removal.');
      process.stdout.write(JSON.stringify({ projectId: project.id, status: result.status, folderPreserved: true }) + '\n');
    }
    const after = await request('GET', '/api/v1/projects'); assert.equal(after.status, 200);
    report.archivedRemaining = after.body.data.projects.filter((project) => project.status === 'archived').length;
    report.activeRemaining = after.body.data.projects.filter((project) => project.status === 'active').length;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally { await request('POST', '/api/v1/auth/logout'); }
}
main().catch((error) => { process.stderr.write(`Archived cleanup failed: ${error.message}\n`); process.exitCode = 1; });
