import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {getSessionMessages, listSessions, renameSession, tagSession} from '@anthropic-ai/claude-agent-sdk';

export const OPENCODE_V1_DB = path.join(os.homedir(), '.local/share/opencode/opencode.db');
export const OPENCODE_V2_DB = path.join(os.homedir(), '.local/share/opencode/opencode-next.db');
export const DEFAULT_OPENCODE_DB = process.env.OPENCODE_DB || (fs.existsSync(OPENCODE_V2_DB) ? OPENCODE_V2_DB : OPENCODE_V1_DB);

export function openCodeSources(dbPath = '') {
  if (dbPath) { const version = detectOpenCodeVersion(dbPath); return [{dbPath, command: version === 2 ? 'opencode2' : 'opencode', version}]; }
  if (process.env.OPENCODE_DB) { const version = detectOpenCodeVersion(process.env.OPENCODE_DB); return [{dbPath: process.env.OPENCODE_DB, command: version === 2 ? 'opencode2' : 'opencode', version}]; }
  return [
    {dbPath: OPENCODE_V2_DB, command: 'opencode2', version: 2},
    {dbPath: OPENCODE_V1_DB, command: 'opencode', version: 1},
  ];
}

export class ClaudeAdapter {
  constructor({sdk = {listSessions, getSessionMessages, renameSession, tagSession}, limit = 300} = {}) {
    this.id = 'claude';
    this.name = 'Claude Code';
    this.newSession = {command: 'claude', args: []};
    this.sdk = sdk;
    this.limit = limit;
  }

  available() {
    return true;
  }

  async sessions() {
    const rows = await this.sdk.listSessions({limit: this.limit});
    return rows.map((row) => ({
      id: row.sessionId,
      harness: this.id,
      harnessName: this.name,
      title: row.summary || row.customTitle || row.firstPrompt || row.sessionId,
      project: shortPath(row.cwd),
      cwd: row.cwd || '',
      branch: row.gitBranch || '',
      tag: row.tag || '',
      isSubagent: false,
      model: '',
      agent: '',
      cost: null,
      tokens: null,
      git: gitInfo(row.cwd),
      capabilities: {rename: true, tag: true, archive: false, delete: false, move: false, preview: true, cost: false, git: true, liveEvents: true},
      updatedAt: epoch(row.lastModified),
      createdAt: epoch(row.createdAt),
      resume: {command: 'claude', args: ['--resume', row.sessionId]},
      raw: row,
    }));
  }

  async preview(session) {
    const messages = await this.sdk.getSessionMessages(session.id, {limit: 8});
    return messages.map((message) => ({role: message.type, text: messageText(message.message)}))
      .filter((message) => ['user', 'assistant'].includes(message.role) && message.text && !isClaudeMetaMessage(message.text));
  }
  async messagesSince(session) { return this.preview(session); }
  projectIdentity(session) { return session.cwd || session.project; }
  prepareLaunch({cwd}) { return {...this.newSession, cwd}; }

  async rename(session, title) { await this.sdk.renameSession(session.id, title, session.cwd ? {dir: session.cwd} : undefined); return {title}; }
  async tag(session, tag) { await this.sdk.tagSession(session.id, tag || null, session.cwd ? {dir: session.cwd} : undefined); return {tag}; }
}

export class OpenCodeAdapter {
  constructor({dbPath = '', sources = openCodeSources(dbPath), sql = defaultSql, exec = execFileSync, hasCommand = commandExists} = {}) {
    this.id = 'opencode';
    this.name = 'OpenCode';
    this.sources = sources;
    this.dbPath = sources[0]?.dbPath || DEFAULT_OPENCODE_DB;
    const launchSource = preferredOpenCodeSource(sources, hasCommand);
    this.newSession = launchSource ? {command: launchSource.command, args: launchArgs(launchSource), ...sourceEnvironment(launchSource)} : null;
    this.sql = sql;
    this.exec = exec;
  }

  available() {
    return this.sources.some((source) => fs.existsSync(source.dbPath)) || Boolean(this.newSession);
  }

  async sessions() {
    if (!this.available()) return [];
    this.error = null;
    const sessions = new Map();
    const errors = [];
    let loaded = 0;
    for (const source of this.sources) {
      if (!fs.existsSync(source.dbPath)) continue;
      let rows;
      try {
        rows = this.sql(source.dbPath, `select s.id, s.title, s.directory, s.path, s.parent_id,
          s.project_id, s.time_created, s.time_updated, s.time_archived, s.agent, s.model, s.cost,
          s.tokens_input, s.tokens_output, s.tokens_reasoning, s.summary_additions, s.summary_deletions, s.summary_files,
          p.name project_name, p.worktree project_worktree
          from session s left join project p on p.id=s.project_id where s.time_archived is null order by s.time_updated desc;`);
        loaded += 1;
      } catch (error) {
        errors.push(error);
        continue;
      }
      for (const row of rows) {
        const normalized = this.normalize(row, source);
        const existing = sessions.get(row.id);
        if (!existing || normalized.updatedAt > existing.updatedAt) sessions.set(row.id, normalized);
      }
    }
    if (!loaded && errors.length) throw errors[0];
    if (errors.length) this.error = new Error(`${errors.length} OpenCode database source${errors.length === 1 ? '' : 's'} failed to load`);
    return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  normalize(row, source) {
    const mutable = source.version === 1;
    const rename = mutable || !isCustomSource(source);
    return {
      id: row.id,
      harness: this.id,
      harnessName: this.name,
      title: row.title || row.id,
      project: row.project_name || shortPath(row.project_worktree) || 'Global',
      cwd: row.directory || row.project_worktree || '',
      branch: '',
      tag: '',
      archivedAt: epoch(row.time_archived),
      model: row.model || '',
      agent: row.agent || '',
      cost: Number(row.cost || 0),
      tokens: {input: Number(row.tokens_input || 0), output: Number(row.tokens_output || 0), reasoning: Number(row.tokens_reasoning || 0)},
      git: {...gitInfo(row.directory || row.project_worktree), additions: Number(row.summary_additions || 0), deletions: Number(row.summary_deletions || 0), files: Number(row.summary_files || 0)},
      capabilities: {rename, tag: false, archive: mutable, delete: false, move: mutable, preview: true, cost: true, git: true, liveEvents: true},
      parentId: row.parent_id || '',
      isSubagent: Boolean(row.parent_id),
      projectId: row.project_id,
      updatedAt: epoch(row.time_updated),
      createdAt: epoch(row.time_created),
      resume: {command: source.command, args: launchArgs(source, row.id), ...sourceEnvironment(source)},
      nativeSource: source,
      raw: {...row, _hsmSource: source},
    };
  }

  async preview(session) {
    const source = this.source(session);
    const dbPath = source.dbPath;
    if (!fs.existsSync(dbPath)) return [];
    try {
      if (source.version === 2 && this.sql(dbPath, "pragma table_info(session_message);").length) {
        const rows = this.sql(dbPath, `select type, data from session_message where session_id=${sqlString(session.id)} and ((type='user' and coalesce(json_extract(data, '$.text'), '') != '') or (type='assistant' and exists (select 1 from json_each(json_extract(data, '$.content')) where json_extract(value, '$.type')='text' and coalesce(json_extract(value, '$.text'), '') != ''))) order by seq desc limit 24;`);
        const messages = rows.reverse().map(extractOpenCodeV2Message).filter((item) => item.text);
        if (messages.length) return messages.slice(-8);
      }
      const partColumns = this.sql(dbPath, "pragma table_info(part);");
      if (partColumns.length) {
        const rows = this.sql(dbPath, `
          select p.message_id, json_extract(m.data, '$.role') as role,
                 json_extract(p.data, '$.text') as text, p.time_created
          from part p
          join message m on m.id = p.message_id
          where p.session_id=${sqlString(session.id)}
            and json_extract(p.data, '$.type')='text'
            and coalesce(json_extract(p.data, '$.text'), '') != ''
          order by p.time_created desc
          limit 24;
        `);
        return groupOpenCodeParts(rows.reverse()).slice(-8);
      }
      const messageColumns = this.sql(dbPath, "pragma table_info(message);");
      if (!messageColumns.length) return [];
      const rows = this.sql(dbPath, `select data from message where session_id=${sqlString(session.id)} order by time_created desc limit 8;`);
      return rows.reverse().map((row) => ({role: 'event', text: extractOpenCodeText(row.data)})).filter((item) => item.text);
    } catch {
      return [];
    }
  }
  async messagesSince(session) { return this.preview(session); }
  projectIdentity(session) { return session.cwd || session.projectId || session.project; }
  prepareLaunch({cwd}) { return {...this.newSession, cwd}; }

  source(session) { return session.nativeSource || session.raw?._hsmSource || this.sources[0]; }
  async rename(session, title) {
    const source = this.source(session);
    if (source.version === 2) {
      if (isCustomSource(source)) throw new Error('Rename is unavailable for a custom OpenCode V2 database.');
      this.exec(source.command, ['api', 'post', `/api/session/${session.id}/rename`, '--data', JSON.stringify({title})], {stdio: 'ignore', env: {...process.env, ...sourceEnvironment(source).env}});
      return {title};
    }
    this.sql(source.dbPath, `update session set title=${sqlString(title)}, time_updated=${Date.now()} where id=${sqlString(session.id)} returning id;`);
    return {title, integrity: integrityCheck(source.dbPath)};
  }
  async archive(session) { const dbPath = this.source(session).dbPath; const backupPath = backupDb(dbPath); this.sql(dbPath, `update session set time_archived=${Date.now()} where id=${sqlString(session.id)} returning id;`); return {archived: true, backupPath, integrity: integrityCheck(dbPath)}; }
  async restore(session) { const dbPath = this.source(session).dbPath; this.sql(dbPath, `update session set time_archived=null where id=${sqlString(session.id)} returning id;`); return {archived: false, integrity: integrityCheck(dbPath)}; }
  async move(session, target) {
    const dbPath = this.source(session).dbPath;
    const project = this.sql(dbPath, `select id, worktree, name from project where id=${sqlString(target)} or lower(name)=lower(${sqlString(target)}) limit 1;`)[0];
    if (!project) throw new Error(`OpenCode project not found: ${target}`);
    const backupPath = backupDb(dbPath);
    this.sql(dbPath, `update session set project_id=${sqlString(project.id)}, directory=${sqlString(project.worktree || session.cwd || '')}, time_updated=${Date.now()} where id=${sqlString(session.id)} returning id;`);
    return {project, backupPath, integrity: integrityCheck(dbPath)};
  }
  async delete(session) { const dbPath = this.source(session).dbPath; this.sql(dbPath, `delete from session where id=${sqlString(session.id)} returning id;`); return {deleted: true}; }
}

export async function loadAll(adapters) {
  const results = await Promise.all(adapters.map(async (adapter) => {
    try {
      const sessions = await adapter.sessions();
      return {adapter, sessions, error: adapter.error || null};
    } catch (error) {
      return {adapter, sessions: [], error};
    }
  }));
  return {
    sessions: results.flatMap((result) => result.sessions).sort((a, b) => b.updatedAt - a.updatedAt),
    sources: results.map(({adapter, sessions, error}) => ({id: adapter.id, name: adapter.name, count: sessions.length, available: adapter.available(), error: error?.message || ''})),
  };
}

const gitCache = new Map();
function backupDb(dbPath) { const dir = path.join(path.dirname(dbPath), 'backups'); fs.mkdirSync(dir, {recursive: true}); const target = path.join(dir, `hsm-${new Date().toISOString().replace(/[:.]/g, '-')}.db`); fs.copyFileSync(dbPath, target); return target; }
function integrityCheck(dbPath) { return execFileSync('sqlite3', [dbPath, 'pragma integrity_check;'], {encoding: 'utf8'}).trim(); }
function gitInfo(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return {branch: '', dirty: false, files: 0};
  if (gitCache.has(cwd)) return gitCache.get(cwd);
  try {
    const branch = execFileSync('git', ['-C', cwd, 'branch', '--show-current'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    const changes = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim().split('\n').filter(Boolean);
    const value = {branch, dirty: changes.length > 0, files: changes.length};
    gitCache.set(cwd, value);
    return value;
  } catch { return {branch: '', dirty: false, files: 0}; }
}

function defaultSql(dbPath, sql) {
  const output = execFileSync('sqlite3', ['-json', dbPath, sql], {encoding: 'utf8'});
  return output.trim() ? JSON.parse(output) : [];
}

function preferredOpenCodeSource(sources, hasCommand) {
  const existing = sources.filter((source) => fs.existsSync(source.dbPath));
  if (existing.length) return existing.find((source) => hasCommand(source.command)) || sources.find((source) => hasCommand(source.command));
  return sources.find((source) => hasCommand(source.command));
}

function commandExists(command) {
  try { execFileSync('which', [command], {stdio: 'ignore'}); return true; } catch { return false; }
}

function detectOpenCodeVersion(dbPath) {
  if (path.basename(dbPath) === 'opencode-next.db') return 2;
  if (!fs.existsSync(dbPath)) return 1;
  try {
    const output = execFileSync('sqlite3', ['-json', dbPath, 'pragma table_info(session);'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    const columns = output.trim() ? JSON.parse(output) : [];
    return columns.some((column) => column.name === 'time_suspended' || column.name === 'fork_session_id') ? 2 : 1;
  } catch { return 1; }
}

function sourceEnvironment(source) { return {env: {OPENCODE_DB: source.dbPath}}; }
function isCustomSource(source) { return source.dbPath !== (source.version === 2 ? OPENCODE_V2_DB : OPENCODE_V1_DB); }
function launchArgs(source, sessionID = '') { return [...(source.version === 2 && isCustomSource(source) ? ['--standalone'] : []), ...(sessionID ? ['-s', sessionID] : [])]; }

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function epoch(value) {
  const number = Number(value || 0);
  return number > 0 && number < 1e12 ? number * 1000 : number;
}

function shortPath(value) {
  if (!value) return '';
  return path.basename(String(value).replace(/\/+$/, ''));
}

function messageText(message) {
  if (typeof message === 'string') return message;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ');
  return '';
}

function isClaudeMetaMessage(text) {
  return text.includes('<local-command-caveat>') || text.includes('<command-name>') || text.includes('<local-command-stdout>');
}

function extractOpenCodeText(data) {
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return parsed?.text || parsed?.content || parsed?.message?.content || '';
  } catch {
    return '';
  }
}

function extractOpenCodeV2Message(row) {
  try {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const text = row.type === 'user' ? data?.text : data?.content?.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
    return {role: row.type, text: text || ''};
  } catch { return {role: row.type || 'event', text: ''}; }
}

function groupOpenCodeParts(rows) {
  const messages = [];
  for (const row of rows) {
    const previous = messages.at(-1);
    if (previous?.messageId === row.message_id) previous.text += `\n${row.text}`;
    else messages.push({messageId: row.message_id, role: row.role || 'event', text: row.text});
  }
  return messages.map(({role, text}) => ({role, text}));
}
