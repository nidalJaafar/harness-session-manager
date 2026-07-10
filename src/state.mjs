import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_STATE_DIR = process.env.HSM_STATE_DIR || path.join(os.homedir(), '.local/state/hsm');

export class StateStore {
  constructor({dir = DEFAULT_STATE_DIR, now = () => Date.now()} = {}) {
    this.dir = dir;
    this.now = now;
    this.statePath = path.join(dir, 'state.json');
    this.eventsPath = path.join(dir, 'events.jsonl');
    this.undoDir = path.join(dir, 'undo');
    this.state = this.readState();
  }

  readState() {
    try {
      return {...defaultState(), ...JSON.parse(fs.readFileSync(this.statePath, 'utf8'))};
    } catch {
      return defaultState();
    }
  }

  save() {
    fs.mkdirSync(this.dir, {recursive: true});
    atomicWrite(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  metadata(key) {
    return this.state.sessions[key] || {};
  }

  updateSession(key, patch) {
    this.state.sessions[key] = {...this.metadata(key), ...patch, modifiedAt: this.now()};
    this.save();
    return this.state.sessions[key];
  }

  setUi(patch) {
    this.state.ui = {...this.state.ui, ...patch};
    this.save();
  }

  appendEvent(event) {
    fs.mkdirSync(this.dir, {recursive: true});
    const normalized = normalizeEvent(event, this.now());
    const latest = this.events(1)[0];
    if (latest && eventIdentity(latest) === eventIdentity(normalized)) return latest;
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(normalized)}\n`);
    return normalized;
  }

  events(limit = 500) {
    try {
      return fs.readFileSync(this.eventsPath, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  recordUndo(record) {
    fs.mkdirSync(this.undoDir, {recursive: true});
    const item = {...record, id: record.id || `${this.now()}-${Math.random().toString(16).slice(2)}`, createdAt: this.now()};
    atomicWrite(path.join(this.undoDir, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`);
    this.state.lastUndo = item.id;
    this.save();
    return item;
  }

  latestUndo() {
    if (!this.state.lastUndo) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.undoDir, `${this.state.lastUndo}.json`), 'utf8')); } catch { return null; }
  }
}

export function sessionKey(sessionOrHarness, id) {
  return typeof sessionOrHarness === 'object' ? `${sessionOrHarness.harness}:${sessionOrHarness.id}` : `${sessionOrHarness}:${id}`;
}

export function normalizeEvent(event, fallbackTime = Date.now()) {
  if (!event?.harness || !event?.sessionId || !event?.type) throw new Error('Event requires harness, sessionId, and type.');
  return {harness: String(event.harness), sessionId: String(event.sessionId), type: String(event.type), timestamp: Number(event.timestamp || fallbackTime), pid: event.pid ? Number(event.pid) : null, cwd: event.cwd || '', message: event.message || ''};
}

function defaultState() { return {version: 1, sessions: {}, ui: {view: 'dashboard', selections: {}, expandedFolders: [], showSubagents: false}, lastUndo: null}; }
function atomicWrite(target, content) { fs.mkdirSync(path.dirname(target), {recursive: true}); const temporary = `${target}.${process.pid}.tmp`; fs.writeFileSync(temporary, content, {mode: 0o600}); fs.renameSync(temporary, target); }
function eventIdentity(event) { return [event.harness, event.sessionId, event.type, event.timestamp, event.pid].join(':'); }
