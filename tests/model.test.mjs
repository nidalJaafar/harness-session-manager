import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAll, OpenCodeAdapter, openCodeSources, OPENCODE_V2_DB} from '../src/adapters.mjs';
import {SessionHubModel, sortByFolderActivity} from '../src/model.mjs';
import {render} from '../src/tui.mjs';
import {StateStore} from '../src/state.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

function adapter(id, rows) {
  return {id, name: id === 'claude' ? 'Claude Code' : 'OpenCode', available: () => true, sessions: async () => rows, preview: async () => [{role: 'user', text: 'hello'}]};
}
function testStore() { return new StateStore({dir: fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-test-'))}); }

const claude = {id: 'c1', harness: 'claude', harnessName: 'Claude Code', title: 'Refactor auth', project: 'api', cwd: process.cwd(), branch: 'develop', updatedAt: 2000, resume: {command: 'claude', args: ['--resume', 'c1']}};
const opencode = {id: 'o1', harness: 'opencode', harnessName: 'OpenCode', title: 'Ship dashboard', project: 'web', cwd: process.cwd(), updatedAt: 3000, resume: {command: 'opencode', args: ['-s', 'o1']}};

test('aggregates adapters into one newest-first queue', async () => {
  const result = await loadAll([adapter('claude', [claude]), adapter('opencode', [opencode])]);
  assert.deepEqual(result.sessions.map((session) => session.id), ['o1', 'c1']);
  assert.deepEqual(result.sources.map((source) => source.count), [1, 1]);
});

test('filters by harness and searches across normalized fields', async () => {
  const model = new SessionHubModel({adapters: [adapter('claude', [claude]), adapter('opencode', [opencode])], store: testStore(), processScanner: () => []});
  await model.load();
  model.focus = 'sources';
  model.move(1);
  assert.deepEqual(model.filtered.map((session) => session.id), ['c1']);
  model.source = 'all'; model.query = 'dashboard'; model.recompute();
  assert.deepEqual(model.filtered.map((session) => session.id), ['o1']);
});

test('renders harness identity and returns native resume action', async () => {
  const model = new SessionHubModel({adapters: [adapter('claude', [claude]), adapter('opencode', [opencode])], store: testStore(), processScanner: () => []});
  await model.load(); model.setView('browser'); model.focus = 'sessions';
  assert.equal(model.selectedRow().type, 'folder');
  await model.key('enter');
  await model.key('down');
  assert.match(render(model), /\[OC\] Ship dashboard/);
  assert.deepEqual(model.openSelected(), {type: 'open', method: 'current', command: 'opencode', args: ['-s', 'o1'], cwd: process.cwd(), sessionKey: 'opencode:o1', label: 'OpenCode'});
});

test('adapter failure does not hide healthy harnesses', async () => {
  const broken = {id: 'broken', name: 'Broken', available: () => true, sessions: async () => { throw new Error('offline'); }};
  const result = await loadAll([broken, adapter('claude', [claude])]);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sources[0].error, 'offline');
});

test('folder view keeps folders together and orders them by latest activity', () => {
  const rows = [
    {...claude, id: 'a-old', cwd: '/work/a', updatedAt: 1000},
    {...opencode, id: 'b-new', cwd: '/work/b', updatedAt: 4000},
    {...claude, id: 'a-new', cwd: '/work/a', updatedAt: 3000},
  ];
  assert.deepEqual(sortByFolderActivity(rows).map((session) => session.id), ['b-new', 'a-new', 'a-old']);
});

test('g toggles between folder and recent views', async () => {
  const model = new SessionHubModel({adapters: [adapter('claude', [claude])], store: testStore(), processScanner: () => []});
  await model.load();
  assert.equal(model.viewMode, 'folders');
  await model.key('g');
  assert.equal(model.viewMode, 'recent');
});

test('folder nodes are collapsed by default and toggle into session leaves', async () => {
  const model = new SessionHubModel({adapters: [adapter('claude', [claude]), adapter('opencode', [opencode])], store: testStore(), processScanner: () => []});
  await model.load(); model.setView('browser');
  assert.deepEqual(model.queueRows().map((row) => row.type), ['folder']);
  await model.key('enter');
  assert.deepEqual(model.queueRows().map((row) => row.type), ['folder', 'session', 'session']);
  const tree = render(model);
  assert.match(tree, /├── \[OC\]/);
  assert.match(tree, /└── \[CC\]/);
  assert.match(tree, /\[CC\] Refactor auth[^\n]*◷ [^\n]*⌂ api[^\n]*⎇ develop/);
});

test('OpenCode preview joins message roles with text parts', async () => {
  const sql = (_db, query) => {
    if (query.includes('pragma table_info(part)')) return [{name: 'data'}];
    if (query.includes('from part p')) return [
      {message_id: 'a', role: 'assistant', text: 'I can help.', time_created: 2},
      {message_id: 'u', role: 'user', text: 'Can you help?', time_created: 1},
    ];
    return [];
  };
  const adapter = new OpenCodeAdapter({dbPath: process.execPath, sql});
  assert.deepEqual(await adapter.preview({id: 's1'}), [
    {role: 'user', text: 'Can you help?'},
    {role: 'assistant', text: 'I can help.'},
  ]);
});

test('OpenCode V2 preview reads native session messages', async () => {
  const sql = (_db, query) => {
    if (query.includes('pragma table_info(session_message)')) return [{name: 'data'}];
    if (query.includes('from session_message')) return [
      {type: 'assistant', data: JSON.stringify({content: [{type: 'reasoning', text: 'hidden'}, {type: 'text', text: 'Implemented it'}]})},
      {type: 'user', data: JSON.stringify({text: 'Support V2'})},
    ];
    return [];
  };
  const source = {dbPath: process.execPath, command: 'opencode2', version: 2};
  const adapter = new OpenCodeAdapter({sources: [source], sql});
  assert.deepEqual(await adapter.preview({id: 's1', nativeSource: source}), [
    {role: 'user', text: 'Support V2'},
    {role: 'assistant', text: 'Implemented it'},
  ]);
});

test('OpenCode loads both databases, deduplicates by newest update, and uses native commands', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-opencode-'));
  const v2 = path.join(dir, 'opencode-next.db');
  const v1 = path.join(dir, 'opencode.db');
  fs.writeFileSync(v2, ''); fs.writeFileSync(v1, '');
  const adapter = new OpenCodeAdapter({
    sources: [{dbPath: v2, command: 'opencode2', version: 2}, {dbPath: v1, command: 'opencode', version: 1}],
    sql: (file) => file === v2
      ? [{id: 'shared', title: 'Older V2', directory: dir, time_updated: 3000}]
      : [{id: 'shared', title: 'Newer V1', directory: dir, time_updated: 4000}, {id: 'legacy', title: 'V1 session', directory: dir, time_updated: 1000}],
  });
  const sessions = await adapter.sessions();
  assert.deepEqual(sessions.map((session) => [session.id, session.resume.command]), [['shared', 'opencode'], ['legacy', 'opencode']]);
  assert.equal(sessions[0].title, 'Newer V1');
});

test('OpenCode keeps a healthy database available when the other source fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-opencode-partial-'));
  const v2 = path.join(dir, 'opencode-next.db');
  const v1 = path.join(dir, 'opencode.db');
  fs.writeFileSync(v2, ''); fs.writeFileSync(v1, '');
  const adapter = new OpenCodeAdapter({
    sources: [{dbPath: v2, command: 'opencode2', version: 2}, {dbPath: v1, command: 'opencode', version: 1}],
    sql: (file) => { if (file === v2) throw new Error('V2 unavailable'); return [{id: 'legacy', title: 'V1 session', time_updated: 1000}]; },
  });
  assert.deepEqual((await adapter.sessions()).map((session) => session.id), ['legacy']);
  assert.match(adapter.error.message, /1 OpenCode database source failed/);
});

test('OpenCode detects custom database generations and isolates custom V2 launches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-opencode-custom-'));
  const custom = path.join(dir, 'custom.db');
  execFileSync('sqlite3', [custom, 'create table session (id text, time_suspended integer);']);
  const adapter = new OpenCodeAdapter({dbPath: custom, hasCommand: () => true});
  assert.equal(adapter.sources[0].version, 2);
  assert.deepEqual(adapter.newSession.args, ['--standalone']);
  assert.equal(adapter.newSession.env.OPENCODE_DB, custom);
  await assert.rejects(adapter.rename({id: 's1', nativeSource: adapter.sources[0]}, 'Rename'), /unavailable for a custom OpenCode V2 database/);

  const calls = [];
  const managedSource = {dbPath: OPENCODE_V2_DB, command: 'opencode2', version: 2};
  const managed = new OpenCodeAdapter({sources: [managedSource], exec: (...args) => calls.push(args), hasCommand: () => true});
  await managed.rename({id: 's1', nativeSource: managedSource}, 'Renamed');
  assert.deepEqual(calls[0][1], ['api', 'post', '/api/session/s1/rename', '--data', '{"title":"Renamed"}']);
  assert.equal(calls[0][2].env.OPENCODE_DB, OPENCODE_V2_DB);
});

test('OPENCODE_DB detects the database generation instead of assuming V2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-opencode-env-'));
  const dbPath = path.join(dir, 'legacy-custom.db');
  execFileSync('sqlite3', [dbPath, 'create table session (id text);']);
  const previous = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = dbPath;
  try { assert.deepEqual(openCodeSources(), [{dbPath, command: 'opencode', version: 1}]); }
  finally { if (previous === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previous; }
});

test('OpenCode launcher falls back to an installed generation without a database yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-opencode-launch-'));
  const v1 = path.join(dir, 'opencode.db');
  fs.writeFileSync(v1, '');
  const adapter = new OpenCodeAdapter({
    sources: [{dbPath: path.join(dir, 'opencode-next.db'), command: 'opencode2', version: 2}, {dbPath: v1, command: 'opencode', version: 1}],
    hasCommand: (command) => command === 'opencode2',
  });
  assert.equal(adapter.newSession.command, 'opencode2');
});

test('OpenCode is launchable before its first database is created', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-opencode-fresh-'));
  const adapter = new OpenCodeAdapter({
    sources: [{dbPath: path.join(dir, 'opencode-next.db'), command: 'opencode2', version: 2}],
    hasCommand: () => true,
  });
  assert.equal(adapter.available(), true);
  assert.equal(adapter.newSession.command, 'opencode2');
});

test('Claude preview excludes local command metadata', async () => {
  const sdk = {
    async getSessionMessages() { return [
      {type: 'user', message: {content: '<local-command-caveat>ignore me</local-command-caveat>'}},
      {type: 'user', message: {content: 'Fix the preview'}},
      {type: 'assistant', message: {content: [{type: 'text', text: 'Preview fixed'}]}},
    ]; },
    async listSessions() { return []; }, async renameSession() {}, async tagSession() {},
  };
  const adapter = new (await import('../src/adapters.mjs')).ClaudeAdapter({sdk});
  assert.deepEqual(await adapter.preview({id: 'c1'}), [
    {role: 'user', text: 'Fix the preview'},
    {role: 'assistant', text: 'Preview fixed'},
  ]);
});
