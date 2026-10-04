/* Disposable PostgreSQL QA. Run from the repo root after building backend.
 * node scripts/check-redesign-database.cjs
 * Reads Docker service credentials only inside the container; never prints them.
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let phase = 'orchestration';

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

async function host() {
  const project = process.env.REDESIGN_QA_COMPOSE_PROJECT ?? 'personal-ai-workspace';
  const container = docker(['ps', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=personal-ai-app', '--format', '{{.ID}}']).trim();
  assert.match(container, /^[a-f0-9]{12,64}$/u, 'Exactly one running application container is required.');
  const root = path.resolve(__dirname, '..');
  if (process.argv.includes('--cleanup-stale-artifacts')) {
    const names = JSON.parse(docker(['exec', container, 'node', '-e', 'process.stdout.write(JSON.stringify(require("node:fs").readdirSync("/tmp").filter(n=>/^pai-redesign-qa-[a-f0-9-]{36}$/.test(n))));']));
    for (const name of names) cleanupArtifacts(container, `/tmp/${name}`);
    process.stdout.write(JSON.stringify({ staleQaArtifactDirectoriesRemoved: names.length }) + '\n');
    return;
  }
  const directory = `/tmp/pai-redesign-qa-${randomUUID()}`;
  assert.match(directory, /^\/tmp\/pai-redesign-qa-[a-f0-9-]{36}$/u);
  docker(['exec', container, 'mkdir', directory]);
  try {
    // Stream files through exec: tmpfs and Windows read-only modes prevent docker cp/tar.
    docker(['exec', container, 'mkdir', `${directory}/dist`]);
    const entries = await bundle(path.join(root, 'backend', 'dist'));
    docker(['exec', '-i', container, 'node', '-e', 'const fs=require("node:fs"),p=require("node:path"),root=process.argv[1];for(const e of JSON.parse(fs.readFileSync(0,"utf8"))){const t=p.resolve(root,e.path);if(!t.startsWith(root+"/"))throw Error("Unsafe artifact path");fs.mkdirSync(p.dirname(t),{recursive:true});fs.writeFileSync(t,Buffer.from(e.data,"base64"));}', `${directory}/dist`], { input: JSON.stringify(entries), stdio: ['pipe', 'pipe', 'pipe'] });
    docker(['exec', '-i', container, 'node', '-e', 'require("node:fs").writeFileSync(process.argv[1],require("node:fs").readFileSync(0));', `${directory}/check.cjs`], { input: await fs.readFile(__filename), stdio: ['pipe', 'pipe', 'pipe'] });
    const output = docker(['exec', '-e', 'NODE_PATH=/app/backend/node_modules:/app/node_modules', '-e', `REDESIGN_QA_DIST=${directory}/dist`, container, 'node', `${directory}/check.cjs`, '--inside']);
    process.stdout.write(output);
  } finally {
    cleanupArtifacts(container, directory);
  }
}

function cleanupArtifacts(container, directory) {
  assert.match(directory, /^\/tmp\/pai-redesign-qa-[a-f0-9-]{36}$/u);
  docker(['exec', container, 'node', '-e', 'const fs=require("node:fs"),path=require("node:path");const p=process.argv[1];const prefix="/tmp/pai-redesign-qa-";if(!p.startsWith(prefix)||!/^[a-f0-9-]{36}$/.test(p.slice(prefix.length)))throw Error("Unsafe QA directory");function writable(d){const s=fs.lstatSync(d);if(s.isDirectory()){fs.chmodSync(d,448);for(const n of fs.readdirSync(d))writable(path.join(d,n));}}if(fs.existsSync(p)){writable(p);fs.rmSync(p,{recursive:true,force:true});}', directory]);
}

async function bundle(root, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await bundle(root, file));
    else if (entry.isFile()) result.push({ path: file.replaceAll(path.sep, '/'), data: (await fs.readFile(path.join(root, file))).toString('base64') });
    else throw new Error('QA build artifacts must be regular files.');
  }
  return result;
}

async function inside() {
  const { Client } = require('pg');
  const dist = process.env.REDESIGN_QA_DIST;
  assert.match(dist ?? '', /^\/tmp\/pai-redesign-qa-[a-f0-9-]{36}\/dist$/u);
  const { createDataSource } = require(path.join(dist, 'infrastructure/database/data-source.js'));
  const database = `pai_redesign_qa_${randomUUID().replaceAll('-', '')}`;
  assert.match(database, /^pai_redesign_qa_[a-f0-9]{32}$/u);
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  const target = new URL(process.env.DATABASE_URL);
  target.pathname = `/${database}`;
  const source = createDataSource({ url: target.toString() });
  let created = false;
  let directory;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    await source.initialize();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-redesign-files-'));
    phase = 'migrations'; await verifyMigrations(source);
    phase = 'legacy-backfill';
    const fixture = await seed(source);
    phase = 'tasks'; await verifyTasks(source, dist, fixture);
    phase = 'overview'; await verifyOverview(source, dist, fixture);
    phase = 'removal'; await verifyRemoval(source, dist, fixture, directory);
    process.stdout.write(JSON.stringify({ verdict: 'PASS', database, checks: ['migration-up-down-up', 'legacy-backfill', 'owner-scoped-overview-order', 'task-metadata-checklist-persistence', 'task-delete-events', 'project-version-owner-busy-guards', 'project-lock-NOWAIT', 'SQL-rollback-backup-restoration', 'full-project-cascade', 'preserved-source-folder', 'private-recovery-purge', 'cleanup-restart-reconciliation', 'postcommit-cleanup-pending-retry'], providerCalls: 0 }) + '\n');
  } finally {
    if (source.isInitialized) await source.destroy();
    if (directory) {
      assert.ok(path.resolve(directory).startsWith(path.join(os.tmpdir(), 'pai-redesign-files-')));
      await fs.rm(directory, { recursive: true, force: true });
    }
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
  }
}

async function verifyMigrations(source) {
  await source.runMigrations({ transaction: 'all' });
  const applied = await source.query('SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 2');
  assert.deepEqual(applied.map((row) => row.name), ['CreateProjectRemovalJobs1710000017000', 'AddTaskPlanningFields1710000016000']);
  await source.undoLastMigration({ transaction: 'all' });
  await source.undoLastMigration({ transaction: 'all' });
  assert.equal((await source.query("SELECT to_regclass('public.project_removal_jobs') AS table_name"))[0].table_name, null);
  const columns = await source.query("SELECT column_name FROM information_schema.columns WHERE table_name='project_tasks' AND column_name IN ('importance','deadline','subtasks')");
  assert.equal(columns.length, 0);
}

async function seed(source) {
  const ownerId = randomUUID(), otherOwnerId = randomUUID(), projectId = randomUUID(), recentProjectId = randomUUID(), otherProjectId = randomUUID();
  for (const [id, key] of [[ownerId, 'qa-local'], [otherOwnerId, 'qa-other']]) await source.query('INSERT INTO users(id,scope_key,password_hash) VALUES ($1,$2,$3)', [id, key, 'qa-not-a-login-hash']);
  for (const [id, owner, name] of [[projectId, ownerId, 'Main'], [recentProjectId, ownerId, 'Recent'], [otherProjectId, otherOwnerId, 'Other']]) {
    await source.query('INSERT INTO projects(id,owner_id,name,slug,relative_root,relative_root_key) VALUES ($1,$2,$3,$4,$5,$5)', [id, owner, name, name.toLowerCase(), `qa/${name.toLowerCase()}`]);
  }
  const legacyId = randomUUID();
  await source.query('INSERT INTO project_tasks(id,owner_id,project_id,title,position) VALUES($1,$2,$3,$4,0)', [legacyId, ownerId, projectId, 'Legacy task']);
  await source.runMigrations({ transaction: 'all' });
  const legacy = (await source.query('SELECT importance,deadline,subtasks FROM project_tasks WHERE id=$1', [legacyId]))[0];
  assert.deepEqual(legacy, { importance: 'medium', deadline: null, subtasks: [] });
  return { ownerId, otherOwnerId, projectId, recentProjectId, otherProjectId, legacyId };
}

async function verifyTasks(source, dist, fixture) {
  const { TypeOrmProjectTaskRepository } = require(path.join(dist, 'infrastructure/database/repositories/typeorm-project-task-repository.js'));
  const repository = new TypeOrmProjectTaskRepository(source);
  const { ownerId, projectId } = fixture;
  const input = { ownerId, projectId, title: 'Persistent checklist', details: 'QA checklist details', importance: 'high', deadline: '2030-04-15', subtasks: [{ id: randomUUID(), title: 'First check', completed: false }], idempotencyKey: 'qa-checklist-key', requestFingerprint: 'qa-checklist-fingerprint' };
  const created = await repository.createTask(input);
  assert.equal(created.task.importance, 'high'); assert.equal(created.task.deadline, '2030-04-15');
  assert.equal((await repository.createTask(input)).task.id, created.task.id);
  const done = await repository.updateTask({ ownerId, projectId, taskId: created.task.id, expectedVersion: 1, text: { subtasks: input.subtasks.map((item) => ({ ...item, completed: true })) } });
  assert.equal(done.task.status, 'done'); assert.ok(done.task.completedAt);
  const reopened = await repository.updateTask({ ownerId, projectId, taskId: created.task.id, expectedVersion: 2, text: { subtasks: input.subtasks } });
  assert.equal(reopened.task.status, 'todo'); assert.equal(reopened.task.completedAt, null);
  const manual = await repository.updateTask({ ownerId, projectId, taskId: created.task.id, expectedVersion: 3, status: 'done' });
  assert.equal(manual.task.subtasks[0].completed, true);
  await assert.rejects(repository.deleteTask({ ownerId, projectId, taskId: created.task.id, expectedVersion: 3 }), (error) => error.code === 'PROJECT_TASK_VERSION_CONFLICT');
  await repository.deleteTask({ ownerId, projectId, taskId: created.task.id, expectedVersion: 4 });
  assert.equal((await source.query('SELECT count(*)::int AS count FROM project_task_events WHERE task_id=$1', [created.task.id]))[0].count, 0);
  fixture.taskRepository = repository;
}

async function verifyOverview(source, dist, fixture) {
  const { TypeOrmProjectOverviewRepository } = require(path.join(dist, 'infrastructure/database/repositories/typeorm-project-overview-repository.js'));
  const repository = new TypeOrmProjectOverviewRepository(source);
  const { ownerId, projectId, recentProjectId, otherProjectId, otherOwnerId } = fixture;
  for (const [title, importance, deadline, project, owner] of [['Same date urgent', 'urgent', '2030-03-02', projectId, ownerId], ['Same date low', 'low', '2030-03-02', projectId, ownerId], ['Earlier low', 'low', '2030-03-01', recentProjectId, ownerId], ['Undated urgent', 'urgent', null, projectId, ownerId], ['Private other owner', 'urgent', '2029-01-01', otherProjectId, otherOwnerId]]) {
    const position = (await source.query('SELECT count(*)::int AS count FROM project_tasks WHERE project_id=$1', [project]))[0].count;
    await source.query('INSERT INTO project_tasks(owner_id,project_id,title,position,importance,deadline) VALUES($1,$2,$3,$4,$5,$6)', [owner, project, title, position, importance, deadline]);
  }
  await source.query("UPDATE projects SET updated_at='2029-01-01T00:00:00Z' WHERE owner_id=$1", [ownerId]);
  await source.query("UPDATE project_tasks SET updated_at='2029-01-01T00:00:00Z' WHERE owner_id=$1", [ownerId]);
  const conversationId = randomUUID();
  await source.query("INSERT INTO conversations(id,owner_id,project_id,title,last_activity_at) VALUES($1,$2,$3,'Recent activity','2031-01-01T00:00:00Z')", [conversationId, ownerId, recentProjectId]);
  const result = await repository.getOverview(ownerId, 6);
  assert.equal(result.projects[0].id, recentProjectId); assert.equal(result.projects.length, 2);
  assert.deepEqual(result.tasks.slice(0, 4).map((task) => task.title), ['Earlier low', 'Same date urgent', 'Same date low', 'Undated urgent']);
  assert.ok(result.tasks.every((task) => task.projectId !== otherProjectId));
  assert.equal((await repository.getOverview(ownerId, 2)).tasks.length, 2);
}

async function seedRemovalHistory(source, fixture) {
  const { ownerId, projectId } = fixture;
  const conversationId = randomUUID(), runId = randomUUID(), permissionId = randomUUID(), suggestionId = randomUUID();
  await source.query("INSERT INTO conversations(id,owner_id,project_id,title) VALUES($1,$2,$3,'Removal history')", [conversationId, ownerId, projectId]);
  await source.query("INSERT INTO messages(conversation_id,role,sequence,content,content_hash,content_length) VALUES($1,'user',1,'QA message',$2,10)", [conversationId, 'a'.repeat(64)]);
  await source.query("INSERT INTO provider_permissions(id,owner_id,project_id,provider_profile,model,capability) VALUES($1,$2,$3,'qa-provider','qa-model','send_selected_context')", [permissionId, ownerId, projectId]);
  await source.query("INSERT INTO ai_runs(id,owner_id,project_id,conversation_id,request,relative_root,manifest,manifest_hash,status,phase,cleanup,create_idempotency_key,request_fingerprint,safe_message,provider_permission_id) VALUES($1,$2,$3,$4,'QA request','qa/main','{}',$5,'succeeded','terminal','complete','qa-run-key','qa-run-fingerprint','Complete',$6)", [runId, ownerId, projectId, conversationId, 'b'.repeat(64), permissionId]);
  await source.query("INSERT INTO ai_run_change_sets(owner_id,project_id,run_id,proposal_hash,status,decision,operations,total_size_bytes,total_line_count,preview_limit_bytes,preview_limit_lines,safe_message) VALUES($1,$2,$3,$4,'applied','approved','[]',0,0,8192,200,'Applied')", [ownerId, projectId, runId, 'c'.repeat(64)]);
  await source.query("INSERT INTO sandbox_commands(owner_id,project_id,run_id,proposal_hash,command,summary,classification,decision,status,limits,create_idempotency_key,create_fingerprint,safe_message) VALUES($1,$2,$3,$4,'qa-mock','No execution','safe','approved','completed','{}','qa-command-key','qa-command-fingerprint','Completed')", [ownerId, projectId, runId, 'd'.repeat(64)]);
  await source.query("INSERT INTO project_facts(owner_id,project_id,fact_key,title,content) VALUES($1,$2,'qa-fact','QA fact','QA content')", [ownerId, projectId]);
  await source.query('INSERT INTO project_chat_context(owner_id,project_id) VALUES($1,$2)', [ownerId, projectId]);
  await source.query("INSERT INTO conversation_idempotency_keys(owner_id,project_id,conversation_id,operation,idempotency_key,request_fingerprint,resource_id) VALUES($1,$2,$3,'conversation','qa-conversation-key','qa-fingerprint',$3)", [ownerId, projectId, conversationId]);
  await source.query("INSERT INTO project_task_suggestions(id,owner_id,project_id,run_id,conversation_id,ordinal,title,subtasks) VALUES($1,$2,$3,$4,$5,0,'QA suggested checklist',$6::jsonb)", [suggestionId, ownerId, projectId, runId, conversationId, JSON.stringify([{ title: 'Suggested child' }])]);
  const accepted = await fixture.taskRepository.resolveSuggestion({ ownerId, projectId, suggestionId, expectedVersion: 1, decision: 'accepted' });
  assert.equal(accepted.task.subtasks[0].title, 'Suggested child'); assert.equal(accepted.task.importance, 'medium');
  return { runId, conversationId };
}

async function verifyRemoval(source, dist, fixture, directory) {
  const { TypeOrmProjectRemovalRepository } = require(path.join(dist, 'infrastructure/database/repositories/typeorm-project-removal-repository.js'));
  const { ProjectRecoveryCleaner } = require(path.join(dist, 'infrastructure/workspace/project-recovery-cleaner.js'));
  const { runId, conversationId } = await seedRemovalHistory(source, fixture);
  const recovery = path.join(directory, 'recovery'), authoritative = path.join(directory, 'qa', 'main');
  await fs.mkdir(path.join(recovery, `run-${runId}`), { recursive: true }); await fs.mkdir(authoritative, { recursive: true });
  await fs.writeFile(path.join(recovery, `run-${runId}`, 'before.bak'), 'Private historical bytes');
  await fs.writeFile(path.join(authoritative, 'source.txt'), 'Authoritative bytes must remain');
  const cleaner = new ProjectRecoveryCleaner(recovery);
  const repository = new TypeOrmProjectRemovalRepository(source, cleaner);
  const input = { ownerId: fixture.ownerId, projectId: fixture.projectId, expectedVersion: 1 };
  await assert.rejects(repository.remove({ ...input, ownerId: fixture.otherOwnerId }), (error) => error.code === 'PROJECT_NOT_FOUND');
  await assert.rejects(repository.remove({ ...input, expectedVersion: 2 }), (error) => error.code === 'PROJECT_VERSION_CONFLICT');
  await source.query("UPDATE ai_runs SET status='running' WHERE id=$1", [runId]);
  await assert.rejects(repository.remove(input), (error) => error.code === 'PROJECT_REMOVAL_BUSY');
  await source.query("UPDATE ai_runs SET status='succeeded' WHERE id=$1", [runId]);
  await verifyRemovalLock(source, repository, input);
  await verifyRemovalRollback(source, repository, input, recovery, runId);
  await cleaner.quarantine([runId]);
  await source.query('INSERT INTO project_removal_jobs(project_id,run_ids) VALUES($1,$2::jsonb)', [fixture.projectId, JSON.stringify([runId])]);
  assert.equal(await repository.cleanupPending(), 1);
  assert.equal(await fs.readFile(path.join(recovery, `run-${runId}`, 'before.bak'), 'utf8'), 'Private historical bytes');
  const failedCleanup = new TypeOrmProjectRemovalRepository(source, {
    quarantine: async (ids) => { const moved = await cleaner.quarantine(ids); return { restore: moved.restore, purge: async () => { throw new Error('QA injected cleanup failure'); } }; },
    restore: (ids) => cleaner.restore(ids), purge: (ids) => cleaner.purge(ids)
  });
  await assert.rejects(failedCleanup.remove(input), (error) => error.code === 'PROJECT_REMOVAL_CLEANUP_PENDING');
  assert.equal((await source.query('SELECT count(*)::int AS count FROM projects WHERE id=$1', [fixture.projectId]))[0].count, 0);
  assert.equal((await source.query('SELECT count(*)::int AS count FROM project_removal_jobs'))[0].count, 1);
  assert.equal(await fs.readFile(path.join(recovery, `.removed-run-${runId}`, 'before.bak'), 'utf8'), 'Private historical bytes');
  assert.equal(await repository.cleanupPending(), 1);
  assert.equal(await fs.readFile(path.join(authoritative, 'source.txt'), 'utf8'), 'Authoritative bytes must remain');
  assert.deepEqual(await fs.readdir(recovery), []);
  for (const table of ['projects', 'conversations', 'ai_runs', 'sandbox_commands', 'ai_run_change_sets', 'project_facts', 'project_tasks', 'project_task_suggestions', 'project_task_events', 'project_task_order_states', 'provider_permissions', 'project_chat_context', 'conversation_idempotency_keys']) {
    const column = table === 'projects' ? 'id' : 'project_id';
    assert.equal((await source.query(`SELECT count(*)::int AS count FROM "${table}" WHERE "${column}"=$1`, [fixture.projectId]))[0].count, 0, `${table} cascade`);
  }
  assert.equal((await source.query('SELECT count(*)::int AS count FROM messages WHERE conversation_id=$1', [conversationId]))[0].count, 0);
  assert.equal((await source.query('SELECT count(*)::int AS count FROM project_removal_jobs'))[0].count, 0);
  assert.equal((await source.query('SELECT count(*)::int AS count FROM projects WHERE id=$1', [fixture.otherProjectId]))[0].count, 1);
}

async function verifyRemovalLock(source, repository, input) {
  const runner = source.createQueryRunner();
  await runner.connect(); await runner.startTransaction();
  try {
    await runner.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [input.projectId]);
    await assert.rejects(repository.remove(input), (error) => error.code === 'PROJECT_REMOVAL_BUSY');
  } finally { await runner.rollbackTransaction(); await runner.release(); }
}

async function verifyRemovalRollback(source, repository, input, recovery, runId) {
  await source.query("CREATE FUNCTION qa_block_project_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'QA injected deletion failure'; END; $$ LANGUAGE plpgsql");
  await source.query('CREATE TRIGGER qa_block_project_delete BEFORE DELETE ON projects FOR EACH ROW EXECUTE FUNCTION qa_block_project_delete()');
  try {
    await assert.rejects(repository.remove(input), (error) => error.code === 'P0001');
    assert.equal((await source.query('SELECT count(*)::int AS count FROM projects WHERE id=$1', [input.projectId]))[0].count, 1);
    assert.equal((await source.query('SELECT count(*)::int AS count FROM project_removal_jobs'))[0].count, 0);
    assert.equal(await fs.readFile(path.join(recovery, `run-${runId}`, 'before.bak'), 'utf8'), 'Private historical bytes');
  } finally {
    await source.query('DROP TRIGGER qa_block_project_delete ON projects');
    await source.query('DROP FUNCTION qa_block_project_delete()');
  }
}

(process.argv.includes('--inside') ? inside() : host()).catch((error) => {
  // Print only classification; connection strings and query parameters remain private.
  const childFailure = error.stderr?.toString().match(/Redesign database QA failed:[^\r\n]*/u)?.[0];
  if (!process.argv.includes('--inside') && !childFailure && error.message) process.stderr.write(`Docker QA orchestration: ${error.message}\n`);
  const details = error instanceof assert.AssertionError || /^[0-9A-Z]{5}$/u.test(error.code ?? '') ? ` (${error.message})` : '';
  process.stderr.write((childFailure ?? `Redesign database QA failed: ${error.code ?? error.name ?? 'UNKNOWN'} in ${phase}${details}`) + '\n');
  process.exitCode = 1;
});
