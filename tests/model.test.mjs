import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAll, OpenCodeAdapter} from '../src/adapters.mjs';
import {SessionHubModel, sortByFolderActivity} from '../src/model.mjs';
import {render} from '../src/tui.mjs';
import {StateStore} from '../src/state.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const model = new SessionHubModel({adapters: [adapter('claude', [claude]), adapter('opencode', [opencode])], openMode: 'tty', store: testStore(), processScanner: () => []});
  await model.load(); model.setView('browser'); model.focus = 'sessions';
  assert.equal(model.selectedRow().type, 'folder');
  await model.key('enter');
  await model.key('down');
  assert.match(render(model), /\[OC\] Ship dashboard/);
  assert.deepEqual(model.openSelected(), {type: 'open', command: 'opencode', args: ['-s', 'o1'], cwd: process.cwd()});
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
