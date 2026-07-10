import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PiAdapter} from '../src/harnesses/pi.mjs';
import {HarnessRegistry} from '../src/harnesses/registry.mjs';

function fixture() {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-pi-'));
  const directory = path.join(agentDir, 'sessions', '--work-demo--');
  fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, 'session.jsonl');
  const rows = [
    {type: 'session', version: 3, id: 'pi-123', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/work/demo'},
    {type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', provider: 'openai', modelId: 'gpt-5'},
    {type: 'message', id: 'u1', parentId: 'm1', timestamp: '2026-01-01T00:00:02.000Z', message: {role: 'user', content: [{type: 'text', text: 'Refactor auth'}]}},
    {type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:03.000Z', message: {role: 'assistant', content: [{type: 'text', text: 'Done'}], model: 'gpt-5', provider: 'openai', usage: {totalTokens: 42, cost: {total: 0.01}}}},
  ];
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return {agentDir, file};
}

test('Pi adapter discovers, normalizes, previews, resumes, and renames sessions', async () => {
  const {agentDir} = fixture();
  const adapter = new PiAdapter({agentDir});
  const [session] = await adapter.sessions();
  assert.equal(session.id, 'pi-123');
  assert.equal(session.title, 'Refactor auth');
  assert.equal(session.model, 'openai/gpt-5');
  assert.equal(session.tokens.input, 42);
  assert.equal(session.cost, 0.01);
  assert.deepEqual(session.resume, {command: 'pi', args: ['--session', 'pi-123']});
  assert.deepEqual(await adapter.preview(session), [{role: 'user', text: 'Refactor auth'}, {role: 'assistant', text: 'Done'}]);
  await adapter.rename(session, 'Auth cleanup');
  assert.equal((await adapter.sessions())[0].title, 'Auth cleanup');
});

test('Pi parent sessions are classified as child threads', async () => {
  const {agentDir, file} = fixture();
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  rows[0].parentSession = '/parent/session.jsonl';
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  assert.equal((await new PiAdapter({agentDir}).sessions())[0].isSubagent, true);
});

test('harness registry validates and creates adapters without UI changes', () => {
  const registry = new HarnessRegistry().register({id: 'demo', name: 'Demo', create: () => ({id: 'demo', name: 'Demo', available() { return true; }, async sessions() { return []; }, async preview() { return []; }})});
  assert.equal(registry.create()[0].id, 'demo');
  assert.throws(() => registry.register({id: 'demo', name: 'Duplicate', create() {}}), /already registered/);
});
