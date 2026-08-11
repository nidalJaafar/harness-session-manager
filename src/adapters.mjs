import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {getSessionMessages, listSessions, renameSession, tagSession} from '@anthropic-ai/claude-agent-sdk';

export const OPENCODE_V1_DB = path.join(os.homedir(), '.local/share/opencode/opencode.db');
export const OPENCODE_V2_DB = path.join(os.homedir(), '.local/share/opencode/opencode-next.db');
export const DEFAULT_OPENCODE_DB = process.env.OPENCODE_DB || (fs.existsSync(OPENCODE_V2_DB) ? OPENCODE_V2_DB : OPENCODE_V1_DB);

export function openCodeSources(dbPath = '') {
  if (dbPath) return [customOpenCodeSource(dbPath)];
  if (process.env.OPENCODE_DB) return [customOpenCodeSource(process.env.OPENCODE_DB)];
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
        const sessionTable = openCodeSessionTable(this, source);
        rows = this.sql(source.dbPath, `select s.id, s.title, s.directory, s.path, s.parent_id,
          s.project_id, s.time_created, s.time_updated, s.time_archived, s.agent, s.model, s.cost,
          s.tokens_input, s.tokens_output, s.tokens_reasoning, s.summary_additions, s.summary_deletions, s.summary_files,
          p.name project_name, p.worktree project_worktree
          from ${sessionTable} s left join project p on p.id=s.project_id where s.time_archived is null order by s.time_updated desc;`);
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
    const compatibility = openCodeCompatibility(source);
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
      model: openCodeModel(row.model),
      agent: row.agent || '',
      cost: Number(row.cost || 0),
      tokens: {input: Number(row.tokens_input || 0), output: Number(row.tokens_output || 0), reasoning: Number(row.tokens_reasoning || 0)},
      git: {...gitInfo(row.directory || row.project_worktree), additions: Number(row.summary_additions || 0), deletions: Number(row.summary_deletions || 0), files: Number(row.summary_files || 0)},
      capabilities: {...compatibility.capabilities},
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
    try { return openCodeCompatibility(source).preview(this, session, source); }
    catch { return []; }
  }
  async messagesSince(session) { return this.preview(session); }
  projectIdentity(session) { return session.cwd || session.projectId || session.project; }
  prepareLaunch({cwd}) { return {...this.newSession, cwd}; }

  source(session) { return session.nativeSource || session.raw?._hsmSource || this.sources[0]; }
  async rename(session, title) {
    const source = this.source(session);
    assertOpenCodeMutation(source, 'rename');
    if (source.version === 2) {
      this.openCodeV2Api(source, 'post', `/api/session/${session.id}/rename`, {title});
      return {title};
    }
    this.sql(source.dbPath, `update session set title=${sqlString(title)}, time_updated=${Date.now()} where id=${sqlString(session.id)} returning id;`);
    return {title, integrity: integrityCheck(source.dbPath)};
  }
  async archive(session) { const source = this.source(session); assertOpenCodeMutation(source, 'archive'); const dbPath = source.dbPath; const backupPath = backupDb(dbPath); const table = openCodeSessionTable(this, source); this.sql(dbPath, `update ${table} set time_archived=${Date.now()} where id=${sqlString(session.id)} returning id;`); return {archived: true, backupPath, integrity: integrityCheck(dbPath)}; }
  async restore(session) { const source = this.source(session); assertOpenCodeMutation(source, 'archive'); const dbPath = source.dbPath; const table = openCodeSessionTable(this, source); this.sql(dbPath, `update ${table} set time_archived=null where id=${sqlString(session.id)} returning id;`); return {archived: false, integrity: integrityCheck(dbPath)}; }
  async move(session, target) {
    const source = this.source(session);
    assertOpenCodeMutation(source, 'move');
    const dbPath = source.dbPath;
    const project = this.sql(dbPath, `select id, worktree, name from project where id=${sqlString(target)} or lower(name)=lower(${sqlString(target)}) limit 1;`)[0];
    if (!project) throw new Error(`OpenCode project not found: ${target}`);
    if (source.version === 2) {
      this.openCodeV2Api(source, 'post', `/api/session/${session.id}/move`, {directory: project.worktree});
      return {project};
    }
    const backupPath = backupDb(dbPath);
    this.sql(dbPath, `update session set project_id=${sqlString(project.id)}, directory=${sqlString(project.worktree || session.cwd || '')}, time_updated=${Date.now()} where id=${sqlString(session.id)} returning id;`);
    return {project, backupPath, integrity: integrityCheck(dbPath)};
  }
  async delete(session) { const source = this.source(session); assertOpenCodeMutation(source, 'delete'); if (source.version === 2) { this.openCodeV2Api(source, 'delete', `/api/session/${session.id}`); return {deleted: true}; } const dbPath = source.dbPath; this.sql(dbPath, `delete from session where id=${sqlString(session.id)} returning id;`); return {deleted: true}; }
  openCodeV2Api(source, method, route, data) {
    const args = ['api', '--standalone', method, route];
    if (data !== undefined) args.push('--data', JSON.stringify(data));
    this.exec(source.command, args, {stdio: 'ignore', env: {...process.env, ...sourceEnvironment(source).env}});
  }
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

function customOpenCodeSource(dbPath) {
  const override = Number(process.env.OPENCODE_VERSION || 0);
  if (override === 1 || override === 2) return {dbPath, command: override === 2 ? 'opencode2' : 'opencode', version: override};
  const filename = path.basename(dbPath);
  if (filename === 'opencode-next.db') return {dbPath, command: 'opencode2', version: 2};
  if (filename === 'opencode.db') return {dbPath, command: 'opencode', version: 1};
  if (hasSqliteTable(dbPath, 'session_v2')) return {dbPath, command: 'opencode2', version: 2};
  // Current V1 and V2 schemas overlap, so arbitrary database names cannot be
  // classified safely from their tables. Preserve V1 launch behavior while
  // disabling writes until OPENCODE_VERSION selects an explicit contract.
  return {dbPath, command: 'opencode', version: 1, ambiguous: true};
}

function hasSqliteTable(dbPath, table) {
  if (!fs.existsSync(dbPath)) return false;
  try {
    const output = execFileSync('sqlite3', ['-noheader', dbPath, `select 1 from sqlite_master where type='table' and name=${sqlString(table)} limit 1;`], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    return output.trim() === '1';
  } catch { return false; }
}

function sourceEnvironment(source) { return {env: {OPENCODE_DB: source.dbPath}}; }
function launchArgs(_source, sessionID = '') { return sessionID ? ['-s', sessionID] : []; }

function openCodeModel(value) {
  if (!value) return '';
  if (typeof value === 'object') return value.providerID && value.id ? `${value.providerID}/${value.id}` : value.id || '';
  if (typeof value !== 'string' || value[0] !== '{') return value;
  try {
    const model = JSON.parse(value);
    return model?.providerID && model?.id ? `${model.providerID}/${model.id}` : model?.id || value;
  } catch { return value; }
}

const OPENCODE_V1_COMPATIBILITY = {
  capabilities: {rename: true, tag: false, archive: true, delete: false, move: true, preview: true, cost: true, git: true, liveEvents: true},
  preview: previewOpenCodeV1,
};

const OPENCODE_V2_COMPATIBILITY = {
  capabilities: {rename: true, tag: false, archive: true, delete: false, move: true, preview: true, cost: true, git: true, liveEvents: false},
  preview: previewOpenCodeV2,
};

const OPENCODE_AMBIGUOUS_COMPATIBILITY = {
  capabilities: {...OPENCODE_V2_COMPATIBILITY.capabilities, rename: false, archive: false, move: false},
  preview: previewOpenCodeV2,
};

function openCodeCompatibility(source) {
  if (source.ambiguous) return OPENCODE_AMBIGUOUS_COMPATIBILITY;
  return source.version === 1 ? OPENCODE_V1_COMPATIBILITY : OPENCODE_V2_COMPATIBILITY;
}
function assertOpenCodeMutation(source, operation) {
  if (source.ambiguous) throw new Error(`${operation[0].toUpperCase()}${operation.slice(1)} is unavailable until OPENCODE_VERSION=1|2 selects the custom OpenCode database generation.`);
  if (!openCodeCompatibility(source).capabilities[operation]) throw new Error(`${operation[0].toUpperCase()}${operation.slice(1)} is unavailable for OpenCode V${source.version}.`);
}

function openCodeSessionTable(adapter, source) {
  if (source.version !== 2) return 'session';
  return adapter.sql(source.dbPath, "pragma table_info(session_v2);").length ? 'session_v2' : 'session';
}

function previewOpenCodeV2(adapter, session, source) {
  const columns = adapter.sql(source.dbPath, "pragma table_info(session_message);");
  if (columns.length) {
    const rows = adapter.sql(source.dbPath, `select type, data from session_message where session_id=${sqlString(session.id)} and ((type='user' and coalesce(json_extract(data, '$.text'), '') != '') or (type='assistant' and exists (select 1 from json_each(json_extract(data, '$.content')) where json_extract(value, '$.type')='text' and coalesce(json_extract(value, '$.text'), '') != ''))) order by seq desc limit 24;`);
    const messages = rows.reverse().map(extractOpenCodeV2Message).filter((item) => item.text);
    if (messages.length) return messages.slice(-8);
  }
  return previewOpenCodeV1(adapter, session, source);
}

function previewOpenCodeV1(adapter, session, source) {
  const partColumns = adapter.sql(source.dbPath, "pragma table_info(part);");
  if (partColumns.length) {
    const rows = adapter.sql(source.dbPath, `
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
  const messageColumns = adapter.sql(source.dbPath, "pragma table_info(message);");
  if (!messageColumns.length) return [];
  const rows = adapter.sql(source.dbPath, `select data from message where session_id=${sqlString(session.id)} order by time_created desc limit 8;`);
  return rows.reverse().map((row) => ({role: 'event', text: extractOpenCodeText(row.data)})).filter((item) => item.text);
}

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
