import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export const DEFAULT_STATE_DIR = process.env.HSM_STATE_DIR || path.join(os.homedir(), '.local/state/hsm');
export const STATE_SCHEMA_VERSION = 2;

export class StateStore {
  constructor({dir = DEFAULT_STATE_DIR, now = () => Date.now(), sql = sqlite} = {}) {
    this.dir = dir; this.now = now; this.sql = sql;
    this.dbPath = path.join(dir, 'hsm.db');
    this.statePath = path.join(dir, 'state.json'); this.eventsPath = path.join(dir, 'events.jsonl'); this.undoDir = path.join(dir, 'undo');
    fs.mkdirSync(dir, {recursive: true});
    this.initialize(); this.migrateLegacy(); this.initializeSearchBackend(); this.state = this.readState();
  }
  initialize() {
    this.sql(this.dbPath, `pragma journal_mode=WAL; pragma busy_timeout=3000;
      create table if not exists kv(key text primary key,value text not null);
      create table if not exists session_metadata(session_key text primary key,data text not null,modified_at integer not null);
      create table if not exists events(id integer primary key,harness text not null,session_id text not null,type text not null,timestamp integer not null,pid integer,cwd text,message text,unique(harness,session_id,type,timestamp,pid));
      create index if not exists events_latest on events(harness,session_id,timestamp desc);
      create unique index if not exists events_identity on events(harness,session_id,type,timestamp,coalesce(pid,-1));
      create table if not exists undo(id text primary key,data text not null,created_at integer not null);
      create table if not exists notifications(session_key text primary key,state text not null,event_timestamp integer not null,notified_at integer not null);
      create table if not exists indexed_sessions(session_key text primary key,harness text,session_id text,title text,project text,cwd text,branch text,status text,updated_at integer,indexed_at integer);
      create table if not exists indexed_messages(id integer primary key,session_key text,harness text,session_id text,project text,branch text,role text,content text,created_at integer,paths text);
      create index if not exists indexed_messages_session on indexed_messages(session_key);
      insert or ignore into kv values('schema_version','${STATE_SCHEMA_VERSION}');`);
  }
  migrateLegacy() {
    if (this.getKv('legacy_migrated')) return;
    if (fs.existsSync(this.statePath)) {
      backup(this.statePath);
      try { const old = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); for (const [key, data] of Object.entries(old.sessions || {})) this.putMetadata(key, data); this.setKv('ui', old.ui || {}); if (old.lastUndo) this.setKv('lastUndo', old.lastUndo); } catch {}
    }
    if (fs.existsSync(this.eventsPath)) {
      backup(this.eventsPath);
      try { for (const line of fs.readFileSync(this.eventsPath, 'utf8').split('\n').filter(Boolean)) this.appendEvent(JSON.parse(line)); } catch {}
    }
    if (fs.existsSync(this.undoDir)) for (const file of fs.readdirSync(this.undoDir).filter((name) => name.endsWith('.json'))) { try { this.putUndo(JSON.parse(fs.readFileSync(path.join(this.undoDir, file), 'utf8'))); } catch {} }
    this.setKv('legacy_migrated', true);
  }
  initializeSearchBackend() { if (this.getKv('search_backend')) return; const fts5=this.query('pragma compile_options').some((row)=>Object.values(row).includes('ENABLE_FTS5')); if(!fts5){this.setKv('search_backend','like');return;} try { this.exec(`create virtual table if not exists messages_fts using fts5(session_key unindexed,harness unindexed,session_id unindexed,project,branch,role,content,created_at unindexed,paths)`); this.setKv('search_backend','fts5'); } catch { this.setKv('search_backend','like'); } }
  readState() { const sessions = {}; for (const row of this.query(`select session_key,data from session_metadata`)) sessions[row.session_key] = parse(row.data, {}); return {version: STATE_SCHEMA_VERSION, sessions, ui: this.getKv('ui') || defaultUi(), lastUndo: this.getKv('lastUndo') || null}; }
  save() { this.setKv('ui', this.state.ui); this.setKv('lastUndo', this.state.lastUndo); }
  metadata(key) { return this.state.sessions[key] || {}; }
  metadataFresh(key) { const row=this.query(`select data from session_metadata where session_key=${quote(key)} limit 1`)[0];return parse(row?.data,{}); }
  putMetadata(key, data) { this.exec(`insert into session_metadata values(${quote(key)},${quote(JSON.stringify(data))},${this.now()}) on conflict(session_key) do update set data=excluded.data,modified_at=excluded.modified_at`); }
  updateSession(key, patch) { const item = {...this.metadata(key), ...patch, modifiedAt: this.now()}; this.state.sessions[key] = item; this.putMetadata(key, item); return item; }
  setUi(patch) { this.state.ui = {...this.state.ui, ...patch}; this.setKv('ui', this.state.ui); }
  appendEvent(event) { const item = normalizeEvent(event, this.now()); this.exec(`insert or ignore into events(harness,session_id,type,timestamp,pid,cwd,message) values(${quote(item.harness)},${quote(item.sessionId)},${quote(item.type)},${item.timestamp},${numberOrNull(item.pid)},${quote(item.cwd)},${quote(item.message)})`); return item; }
  events(limit = 500) { return this.query(`select harness,session_id as sessionId,type,timestamp,pid,cwd,message from events order by timestamp desc,id desc limit ${Number(limit)}`); }
  putUndo(item) { this.exec(`insert or replace into undo values(${quote(item.id)},${quote(JSON.stringify(item))},${Number(item.createdAt || this.now())})`); }
  recordUndo(record) { const item = {...record,id: record.id || `${this.now()}-${Math.random().toString(16).slice(2)}`,createdAt: this.now()}; this.putUndo(item); this.state.lastUndo = item.id; this.setKv('lastUndo', item.id); return item; }
  latestUndo() { const id = this.state.lastUndo; if (!id) return null; return parse(this.query(`select data from undo where id=${quote(id)} limit 1`)[0]?.data, null); }
  getKv(key) { return parse(this.query(`select value from kv where key=${quote(key)} limit 1`)[0]?.value, null); }
  setKv(key, value) { this.exec(`insert into kv values(${quote(key)},${quote(JSON.stringify(value))}) on conflict(key) do update set value=excluded.value`); }
  query(statement) { return this.sql(this.dbPath, statement, true); }
  exec(statement) { return this.sql(this.dbPath, statement, false); }
  integrity() { return this.query('pragma integrity_check')[0]?.integrity_check || 'unknown'; }
}

export function sessionKey(sessionOrHarness, id) { return typeof sessionOrHarness === 'object' ? `${sessionOrHarness.harness}:${sessionOrHarness.id}` : `${sessionOrHarness}:${id}`; }
export function normalizeEvent(event, fallbackTime = Date.now()) { if (!event?.harness || !event?.sessionId || !event?.type) throw new Error('Event requires harness, sessionId, and type.'); return {harness:String(event.harness),sessionId:String(event.sessionId),type:String(event.type),timestamp:Number(event.timestamp || fallbackTime),pid:event.pid ? Number(event.pid) : null,cwd:event.cwd || '',message:event.message || ''}; }
export function sqlite(db, statement, json = false) { const args = ['-cmd', '.timeout 10000', ...(json ? ['-json'] : []), db, statement]; const output = execFileSync('sqlite3', args, {encoding:'utf8',maxBuffer:32*1024*1024}); return json && output.trim() ? JSON.parse(output) : []; }
export function quote(value) { return `'${String(value ?? '').replaceAll("'", "''")}'`; }
function numberOrNull(value) { return Number.isFinite(Number(value)) && value != null ? Number(value) : 'null'; }
function parse(value, fallback) { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } }
function defaultUi() { return {view:'dashboard',selections:{},expandedFolders:[],showSubagents:false}; }
function backup(file) { const target = `${file}.pre-sqlite-backup`; if (!fs.existsSync(target)) fs.copyFileSync(file, target); return target; }
