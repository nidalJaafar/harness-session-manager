import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SessionHubModel} from '../src/model.mjs';
import {applyLiveState, deriveStatus, scanHarnessProcesses} from '../src/live.mjs';
import {StateStore, sessionKey} from '../src/state.mjs';
import {ensureHooksInstalled} from '../src/cli.mjs';

function fixture() {
  return {id: 's1', harness: 'claude', harnessName: 'Claude Code', title: 'Fix login', project: 'api', cwd: process.cwd(), updatedAt: Date.now(), resume: {command: 'claude', args: ['--resume', 's1']}, capabilities: {rename: true, preview: true}, git: {branch: 'main', dirty: true, files: 2}};
}
function adapter(rows) { return {id: 'claude', name: 'Claude Code', available: () => true, sessions: async () => rows, preview: async () => [{role: 'user', text: 'fix it'}, {role: 'assistant', text: 'done'}], rename: async () => {}}; }
function setup() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-command-')); const store = new StateStore({dir}); return {dir, store}; }

test('state persists metadata, UI state, events, and undo records', () => {
  const {dir, store} = setup();
  store.updateSession('claude:s1', {pinned: true, alias: 'Login'});
  store.setUi({view: 'browser'});
  store.appendEvent({harness: 'claude', sessionId: 's1', type: 'waiting', timestamp: 10});
  store.recordUndo({type: 'rename', session: 'claude:s1', before: 'Old'});
  const restored = new StateStore({dir});
  assert.equal(restored.metadata('claude:s1').pinned, true);
  assert.equal(restored.state.ui.view, 'browser');
  assert.equal(restored.events()[0].type, 'waiting');
  assert.equal(restored.latestUndo().before, 'Old');
});

test('duplicate lifecycle events are ignored', () => {
  const {store} = setup();
  const event = {harness: 'opencode', sessionId: 's1', type: 'running', timestamp: 10, pid: 2};
  store.appendEvent(event); store.appendEvent(event);
  assert.equal(store.events().length, 1);
});

test('live status transitions handle waiting, running, stale, failed and completed', () => {
  const now = 1_000_000;
  assert.equal(deriveStatus({event: {type: 'waiting', timestamp: now}, process: {pid: 1}, now}).status, 'waiting');
  assert.equal(deriveStatus({event: {type: 'running', timestamp: now}, process: {pid: 1}, now}).status, 'running');
  assert.equal(deriveStatus({event: {type: 'running', timestamp: 1}, process: null, now}).status, 'stale');
  assert.equal(deriveStatus({event: {type: 'failed', timestamp: now}, process: null, now}).status, 'failed');
  assert.equal(deriveStatus({event: {type: 'completed', timestamp: now}, process: null, now}).status, 'completed');
});

test('unknown events do not prevent known sessions from loading', () => {
  const session = fixture();
  const rows = applyLiveState([session], [{harness: 'claude', sessionId: 'unknown', type: 'running', timestamp: Date.now()}], []);
  assert.equal(rows[0].status, 'offline');
});

test('process detection preserves case-sensitive IDs and ignores terminal wrappers', () => {
  const processes = scanHarnessProcesses({exec: () => [
    {pid: 1, executable: 'ghostty', command: 'ghostty -e opencode -s ses_ABC123'},
    {pid: 2, executable: 'opencode', command: 'opencode -s ses_ABC123'},
  ]});
  assert.deepEqual(processes, [{harness: 'opencode', sessionId: 'ses_ABC123', pid: 2, cwd: ''}]);
});

test('anonymous harness process marks only the newest session in its cwd running', () => {
  const cwd = process.cwd();
  const old = {...fixture(), id: 'old', updatedAt: 1};
  const recent = {...fixture(), id: 'recent', updatedAt: 2};
  const rows = applyLiveState([old, recent], [], [{harness: 'claude', sessionId: '', pid: 9, cwd}]);
  assert.equal(rows.find((session) => session.id === 'recent').status, 'running');
  assert.equal(rows.find((session) => session.id === 'old').status, 'offline');
});

test('dashboard is default and assigns waiting and pinned lanes', async () => {
  const {store} = setup();
  store.updateSession(sessionKey(fixture()), {pinned: true});
  store.appendEvent({harness: 'claude', sessionId: 's1', type: 'waiting', timestamp: Date.now(), pid: 8});
  const model = new SessionHubModel({adapters: [adapter([fixture()])], store, processScanner: () => [{harness: 'claude', sessionId: 's1', pid: 8}]});
  await model.load();
  assert.equal(model.view, 'dashboard');
  assert.equal(model.sessions[0].status, 'waiting');
  assert.ok(model.dashboardRows().some((row) => row.lane === 'pinned'));
});

test('view selection and pin state persist', async () => {
  const {dir, store} = setup();
  const model = new SessionHubModel({adapters: [adapter([fixture()])], store, processScanner: () => []});
  await model.load(); model.setView('browser'); model.query = 's1'; model.recompute(); model.selectedSession = 0;
  model.view = 'dashboard'; model.selectedSession = model.rows().findIndex((row) => row.type === 'session'); model.togglePin();
  const restored = new StateStore({dir});
  assert.equal(restored.state.ui.view, 'browser');
  assert.equal(restored.metadata('claude:s1').pinned, true);
});

test('command palette fuzzy-searches actions and sessions and marks unsupported actions', async () => {
  const {store} = setup();
  const model = new SessionHubModel({adapters: [adapter([fixture()])], store, processScanner: () => []});
  await model.load(); model.selectedSession = 1;
  model.paletteQuery = 'rsme';
  assert.equal(model.paletteItems()[0].id, 'resume');
  model.paletteQuery = 'delete';
  assert.equal(model.paletteItems()[0].enabled, false);
});

test('palette explains when a lane is selected instead of a session', async () => {
  const {store} = setup();
  const model = new SessionHubModel({adapters: [adapter([fixture()])], store, processScanner: () => []});
  await model.load(); model.selectedSession = 0; model.paletteQuery = 'resume';
  const resume = model.paletteItems().find((item) => item.id === 'resume');
  assert.equal(resume.enabled, false);
  assert.equal(resume.reason, 'Select a session row first');
  model.palette = true; model.paletteQuery = 'resume'; model.paletteIndex = 0;
  await model.paletteKey('enter');
  assert.equal(model.palette, true);
  assert.equal(model.paletteMessage, 'Select a session row first');
});

test('palette resume returns a tty launch action', async () => {
  const {store} = setup();
  const model = new SessionHubModel({adapters: [adapter([fixture()])], store, processScanner: () => [], openMode: 'tty'});
  await model.load();
  model.palette = true; model.paletteQuery = 'resume'; model.paletteIndex = 0;
  const result = await model.paletteKey('enter');
  assert.deepEqual(result, {type: 'open', command: 'claude', args: ['--resume', 's1'], cwd: process.cwd()});
});

test('hide is confirmed by workflow state and undo restores local visibility', async () => {
  const {store} = setup();
  const model = new SessionHubModel({adapters: [adapter([fixture()])], store, processScanner: () => []});
  await model.load();
  const session = model.sessions[0];
  await model.destructiveAction('hide', session);
  assert.equal(store.metadata('claude:s1').hidden, true);
  await model.undoLatest();
  assert.equal(store.metadata('claude:s1').hidden, false);
});

test('archive creates an undo record and invokes adapter restore', async () => {
  const {store} = setup();
  let archived = false;
  const row = {...fixture(), capabilities: {...fixture().capabilities, archive: true}};
  const managed = {...adapter([]), sessions: async () => archived ? [] : [row], archive: async () => { archived = true; return {backupPath: '/tmp/backup.db'}; }, restore: async () => { archived = false; }};
  const model = new SessionHubModel({adapters: [managed], store, processScanner: () => []});
  await model.load();
  await model.destructiveAction('archive', model.sessions[0]);
  assert.equal(archived, true);
  assert.equal(store.latestUndo().backupPath, '/tmp/backup.db');
  await model.undoLatest();
  assert.equal(archived, false);
});

test('subagent threads are hidden by default and hotkey preference persists', async () => {
  const {dir, store} = setup();
  const parent = fixture();
  const child = {...fixture(), id: 'child', title: 'Explore code', isSubagent: true, parentId: 's1'};
  const model = new SessionHubModel({adapters: [adapter([parent, child])], store, processScanner: () => []});
  await model.load();
  assert.deepEqual(model.filtered.map((session) => session.id), ['s1']);
  await model.key('s');
  assert.deepEqual(model.filtered.map((session) => session.id), ['s1', 'child']);
  assert.equal(new StateStore({dir}).state.ui.showSubagents, true);
});

test('explicit showSubagents option overrides persisted preference', async () => {
  const {store} = setup();
  store.setUi({showSubagents: false});
  const child = {...fixture(), id: 'child', isSubagent: true};
  const model = new SessionHubModel({adapters: [adapter([fixture(), child])], store, processScanner: () => [], showSubagents: true});
  await model.load();
  assert.equal(model.filtered.length, 2);
});

test('first-run hook bootstrap installs only when an integration is missing', () => {
  let installs = 0;
  let installed = false;
  const status = () => installed ? {claude: true, opencode: true, pi: true} : {claude: false, opencode: true, pi: false};
  const install = () => { installs += 1; installed = true; };
  assert.equal(ensureHooksInstalled({status, install}).installed, true);
  assert.equal(ensureHooksInstalled({status, install}).installed, false);
  assert.equal(installs, 1);
});

test('obsolete activity view preference migrates to dashboard', () => {
  const {store} = setup();
  store.setUi({view: 'activity'});
  const model = new SessionHubModel({adapters: [], store, processScanner: () => []});
  assert.equal(model.view, 'dashboard');
});

test('question mark opens complete keyboard help and escape closes it', async () => {
  const {store} = setup();
  const model = new SessionHubModel({adapters: [], store, processScanner: () => []});
  await model.key('?');
  assert.equal(model.help, true);
  await model.key('esc');
  assert.equal(model.help, false);
});
