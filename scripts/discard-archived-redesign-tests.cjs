/* Maintenance-only discard of two explicitly authorized archived testing projects.
 * Ordinary project DELETE guards are deliberately unchanged. Stop the app service,
 * then run from the repository: node scripts/discard-archived-redesign-tests.cjs
 * --owner <uuid> [--execute]. Default performs a rollback-only inspection.
 * Compose config supplies credentials privately; no provider adapter is loaded.
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const TARGETS = [
  { id: 'c8c0c303-3761-4f4c-9013-76b6485439d9', name: 'MVP2 live API check', version: 3, relativeRoot: '.' },
  { id: '8a7fafbe-5dd2-4e44-9b0e-841d605d7e0e', name: 'Automatic files check e1f3280d', version: 2, relativeRoot: 'apps/automatic-files-check-e1f3280d' }
];
const TERMINAL = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'rejected', 'review_required']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

function guardStates(project, target, ownerId, runs, changes, commands) {
  assert(project && project.id === target.id && project.owner_id === ownerId, 'Owned target is missing.');
  assert(project.status === 'archived' && project.version === target.version && project.name === target.name && project.relative_root === target.relativeRoot, 'Target identity, archived state or version changed.');
  for (const record of [...runs, ...changes, ...commands]) assert(record.owner_id === ownerId && record.project_id === target.id, 'Dependent ownership mismatch.');
  for (const run of runs) {
    assert(TERMINAL.has(run.status), 'Reject pending consent through the supported API; active runs cannot be discarded.');
    assert(run.runtime_reference === null && ['direct', null].includes(run.runtime_kind), 'A sandbox/runtime execution handle remains.');
    assert(run.runtime_kind === 'direct' || !run.sandbox_ready, 'Unexpected runtime resources remain.');
    assert(run.status !== 'review_required' || run.runtime_kind === 'direct', 'Only terminal direct-runtime review history can be discarded.');
  }
  assert(commands.length === 0, 'Sandbox command history requires separate review.');
  assert(changes.every(change => !['awaiting_approval', 'applying'].includes(change.status)), 'Pending or applying file changes remain.');
  for (const change of changes) {
    const run = runs.find(candidate => candidate.id === change.run_id);
    assert(run && run.runtime_kind === 'direct' && TERMINAL.has(run.status), 'File changes lack a terminal direct run.');
  }
}

async function fingerprint(root, relative) {
  const target = path.resolve(root, relative);
  assert(target === root || target.startsWith(root + path.sep), 'Source folder escapes workspace.');
  // Walk each parent to reject link traversal, including a missing final folder.
  let current = path.parse(target).root;
  for (const component of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { const stat = await fs.lstat(current); assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Linked/non-directory source parent.'); }
    catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
  }
  const digest = createHash('sha256');
  const pending = [{ absolute: target, relative: '.' }];
  let entries = 0, bytes = 0;
  while (pending.length) {
    const entry = pending.pop();
    const stat = await fs.lstat(entry.absolute);
    assert(++entries <= 100000 && !stat.isSymbolicLink(), 'Source fingerprint entry bound or link check failed.');
    assert(stat.isFile() || stat.isDirectory(), 'Unsupported source entry.');
    digest.update(JSON.stringify([entry.relative, stat.isDirectory() ? 'directory' : 'file', stat.mode]));
    if (stat.isDirectory()) {
      const names = (await fs.readdir(entry.absolute)).sort().reverse();
      pending.push(...names.map(name => ({ absolute: path.join(entry.absolute, name), relative: path.join(entry.relative, name) })));
    } else {
      bytes += stat.size;
      assert(bytes <= 256 * 1024 * 1024, 'Source fingerprint exceeds 256 MiB; refuse unbounded operator work.');
      digest.update(await fs.readFile(entry.absolute));
    }
  }
  return { exists: true, entries, bytes, sha256: digest.digest('hex') };
}

async function host() {
  const ownerId = process.argv[process.argv.indexOf('--owner') + 1];
  assert(process.argv.includes('--owner') && UUID.test(ownerId), 'Pass --owner <authenticated owner UUID>.');
  const project = process.env.REDESIGN_QA_COMPOSE_PROJECT ?? 'personal-ai-workspace';
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const running = docker(['ps', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=personal-ai-app', '--format', '{{.ID}}']).trim();
  assert(running === '', 'Stop the application service first; discard is allowed only without a source-writing app process.');
  const args = ['compose', '--project-name', project, '-f', 'compose.yaml'];
  const files = process.env.REDESIGN_DISCARD_COMPOSE_FILES?.split(';').filter(Boolean) ?? [];
  for (const file of files) args.push('-f', file);
  args.push('run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', 'personal-ai-app', '-', '--inside', '--owner', ownerId);
  if (process.argv.includes('--execute')) args.push('--execute');
  const output = execFileSync('docker', args, { cwd: path.resolve(__dirname, '..'), input: await fs.readFile(__filename), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  process.stdout.write(output);
}

async function inside() {
  // This maintenance process has no HTTP listener, provider stream or runtime.
  const { createDataSource } = require('/app/backend/dist/infrastructure/database/data-source.js');
  const { ProjectRecoveryCleaner } = require('/app/backend/dist/infrastructure/workspace/project-recovery-cleaner.js');
  const ownerId = process.argv[process.argv.indexOf('--owner') + 1];
  assert(UUID.test(ownerId), 'Invalid owner.');
  const execute = process.argv.includes('--execute');
  const source = createDataSource({ url: process.env.DATABASE_URL });
  const cleaner = new ProjectRecoveryCleaner(process.env.RECOVERY_ROOT ?? '/var/lib/personal-ai/recovery');
  const root = path.resolve(process.env.WORKSPACE_ROOT ?? '/workspace');
  const results = [];
  await source.initialize();
  try {
    // Preflight BOTH targets before either can be removed.
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let commitAttempted = false, committed = false;
    const jobs = [];
    try {
      for (const target of TARGETS) {
        const projects = await runner.query('SELECT id,owner_id,name,status,version,relative_root FROM projects WHERE id=$1 FOR UPDATE NOWAIT', [target.id]);
        if (!projects.length) { results.push({ projectId: target.id, alreadyAbsent: true }); continue; }
        const runs = await runner.query('SELECT id,owner_id,project_id,status,runtime_kind,runtime_reference,sandbox_ready FROM ai_runs WHERE project_id=$1 ORDER BY id FOR UPDATE NOWAIT', [target.id]);
        const changes = await runner.query('SELECT id,owner_id,project_id,run_id,status FROM ai_run_change_sets WHERE project_id=$1 ORDER BY id FOR UPDATE NOWAIT', [target.id]);
        const commands = await runner.query('SELECT id,owner_id,project_id,status FROM sandbox_commands WHERE project_id=$1 ORDER BY id FOR UPDATE NOWAIT', [target.id]);
        guardStates(projects[0], target, ownerId, runs, changes, commands);
        const stagedRoot = process.env.STAGING_ROOT ?? '/var/lib/personal-ai/staging';
        for (const run of runs) {
          try { await fs.lstat(path.join(stagedRoot, `run-${run.id}`)); throw new Error('Staging resources remain; refuse discard.'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        assert((await source.query('SELECT project_id FROM project_removal_jobs WHERE project_id=$1', [target.id])).length === 0, 'Reconcile existing cleanup job before discard.');
        results.push({ projectId: target.id, before: await fingerprint(root, target.relativeRoot), runIds: runs.map(run => run.id), changeSets: changes.length });
      }
      for (const result of results) {
        if (result.alreadyAbsent) continue;
        const target = TARGETS.find(candidate => candidate.id === result.projectId);
        assert.deepEqual(await fingerprint(root, target.relativeRoot), result.before, 'Source changed during preflight; refuse discard.');
      }
      if (!execute) { await runner.rollbackTransaction(); return { mode: 'dry-run', results }; }
      for (const result of results) {
        if (result.alreadyAbsent) continue;
        await source.query('INSERT INTO project_removal_jobs(project_id,run_ids) VALUES ($1,$2::jsonb)', [result.projectId, JSON.stringify(result.runIds)]);
        jobs.push(result);
        await cleaner.quarantine(result.runIds);
        await runner.query('DELETE FROM projects WHERE id=$1 AND owner_id=$2 AND status=$3', [result.projectId, ownerId, 'archived']);
      }
      for (const result of jobs) {
        const target = TARGETS.find(candidate => candidate.id === result.projectId);
        assert.deepEqual(await fingerprint(root, target.relativeRoot), result.before, 'Source folder changed before commit.');
      }
      commitAttempted = true;
      await runner.commitTransaction(); committed = true;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      // Unknown commit response is resolved from durable project presence.
      for (const job of jobs) {
        const present = (await source.query('SELECT id FROM projects WHERE id=$1', [job.projectId])).length > 0;
        if (present) await cleaner.restore(job.runIds);
        else if (commitAttempted) await cleaner.purge(job.runIds);
        else throw new Error('Unexpected missing target after rollback; cleanup intent retained.');
        await source.query('DELETE FROM project_removal_jobs WHERE project_id=$1', [job.projectId]);
      }
      throw error;
    } finally { await runner.release(); }
    assert(committed, 'Discard was not committed.');
    for (const job of jobs) {
      await cleaner.purge(job.runIds); // Failure deliberately retains durable intent.
      await source.query('DELETE FROM project_removal_jobs WHERE project_id=$1', [job.projectId]);
    }
    for (const result of results) {
      if (result.alreadyAbsent) continue;
      const target = TARGETS.find(candidate => candidate.id === result.projectId);
      result.after = await fingerprint(root, target.relativeRoot);
      assert.deepEqual(result.after, result.before, 'Source fingerprint changed after discard.');
      assert((await source.query('SELECT id FROM projects WHERE id=$1', [result.projectId])).length === 0, 'Target remains after commit.');
    }
    return { mode: 'execute', verdict: 'PASS', sourcePreserved: true, providerCalls: 0, results };
  } finally { await source.destroy(); }
}

if (require.main === module || process.argv[1] === '-') {
  (process.argv.includes('--inside') ? inside() : host()).then(result => {
    if (result) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    // Docker command errors may contain compose environment values; never echo them.
    const message = error.status !== undefined ? 'Maintenance Docker operation failed. Inspect container logs without exposing credentials.' : error.message;
    process.stderr.write(JSON.stringify({ verdict: 'FAIL', code: error.code, message }) + '\n'); process.exitCode = 1;
  });
}
module.exports = { guardStates, fingerprint, TARGETS };
