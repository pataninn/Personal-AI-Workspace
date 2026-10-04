const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, mkdir, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { guardStates, fingerprint, TARGETS } = require('./discard-archived-redesign-tests.cjs');
const ownerId = '79c62281-3761-4f4c-9013-76b6485439d9';
const target = TARGETS[0];
const project = { id: target.id, owner_id: ownerId, status: 'archived', version: target.version, name: target.name, relative_root: target.relativeRoot };
const run = { id: 'b5dc3b4f-07a4-4e13-8dc0-cd5f98ffd313', owner_id: ownerId, project_id: target.id, status: 'review_required', runtime_kind: 'direct', runtime_reference: null, sandbox_ready: true };
function check(overrides = {}) { guardStates(overrides.project ?? project, target, ownerId, overrides.runs ?? [run], overrides.changes ?? [], overrides.commands ?? []); }

test('accepts terminal direct review history without altering outcome', () => { check(); assert.equal(run.status, 'review_required'); });
test('refuses every nonterminal run including unapproved consent', () => {
  for (const status of ['pending_approval', 'staging', 'ready', 'queued', 'running', 'waiting_approval', 'cancel_requested']) assert.throws(() => check({ runs: [{ ...run, status }] }));
});
test('refuses owner/version/status/identity mismatches', () => {
  for (const patch of [{ owner_id: target.id }, { version: 4 }, { status: 'active' }, { name: 'different' }, { relative_root: '../elsewhere' }]) assert.throws(() => check({ project: { ...project, ...patch } }));
  assert.throws(() => check({ runs: [{ ...run, owner_id: target.id }] }));
});
test('refuses runtime resources, commands and pending/applying changes', () => {
  for (const patch of [{ runtime_reference: 'sandbox-ref' }, { runtime_kind: 'hermes' }, { runtime_kind: 'fake' }, { runtime_kind: null }]) assert.throws(() => check({ runs: [{ ...run, ...patch }] }));
  assert.throws(() => check({ commands: [{ owner_id: ownerId, project_id: target.id, status: 'completed' }] }));
  for (const status of ['applying', 'awaiting_approval']) assert.throws(() => check({ changes: [{ owner_id: ownerId, project_id: target.id, run_id: run.id, status }] }));
});
test('allows approved manual-review history attached to terminal direct run', () => {
  check({ changes: [{ owner_id: ownerId, project_id: target.id, run_id: run.id, status: 'needs_manual_review' }] });
});
test('fingerprints source bytes/tree, preserves missing folder, refuses escape', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pai-discard-test-'));
  try {
    await mkdir(path.join(directory, 'project')); await writeFile(path.join(directory, 'project', 'source.txt'), 'first');
    const before = await fingerprint(directory, 'project');
    assert.deepEqual(await fingerprint(directory, 'project'), before);
    await writeFile(path.join(directory, 'project', 'source.txt'), 'second');
    assert.notDeepEqual(await fingerprint(directory, 'project'), before);
    assert.deepEqual(await fingerprint(directory, 'missing'), { exists: false });
    await assert.rejects(fingerprint(directory, '../outside'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
