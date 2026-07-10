import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {getSessionMessages, listSessions, renameSession, tagSession} from '@anthropic-ai/claude-agent-sdk';

export const DEFAULT_OPENCODE_DB = path.join(os.homedir(), '.local/share/opencode/opencode.db');

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

  async rename(session, title) { await this.sdk.renameSession(session.id, title, session.cwd ? {dir: session.cwd} : undefined); return {title}; }
  async tag(session, tag) { await this.sdk.tagSession(session.id, tag || null, session.cwd ? {dir: session.cwd} : undefined); return {tag}; }
}

export class OpenCodeAdapter {
  constructor({dbPath = DEFAULT_OPENCODE_DB, sql = defaultSql} = {}) {
    this.id = 'opencode';
    this.name = 'OpenCode';
    this.newSession = {command: 'opencode', args: []};
    this.dbPath = dbPath;
    this.sql = sql;
  }

  available() {
    return fs.existsSync(this.dbPath);
  }

  async sessions() {
    if (!this.available()) return [];
    const rows = this.sql(this.dbPath, `select s.id, s.title, s.directory, s.path, s.parent_id,
      s.project_id, s.time_created, s.time_updated, s.time_archived, s.agent, s.model, s.cost,
      s.tokens_input, s.tokens_output, s.tokens_reasoning, s.summary_additions, s.summary_deletions, s.summary_files,
      p.name project_name, p.worktree project_worktree
      from session s left join project p on p.id=s.project_id where s.time_archived is null order by s.time_updated desc;`);
    return rows.map((row) => ({
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
      capabilities: {rename: true, tag: false, archive: true, delete: false, move: true, preview: true, cost: true, git: true, liveEvents: true},
      parentId: row.parent_id || '',
      isSubagent: Boolean(row.parent_id),
      projectId: row.project_id,
      updatedAt: epoch(row.time_updated),
      createdAt: epoch(row.time_created),
      resume: {command: 'opencode', args: ['-s', row.id]},
      raw: row,
    }));
  }

  async preview(session) {
    if (!this.available()) return [];
    try {
      const partColumns = this.sql(this.dbPath, "pragma table_info(part);");
      if (partColumns.length) {
        const rows = this.sql(this.dbPath, `
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
      const messageColumns = this.sql(this.dbPath, "pragma table_info(message);");
      if (!messageColumns.length) return [];
      const rows = this.sql(this.dbPath, `select data from message where session_id=${sqlString(session.id)} order by time_created desc limit 8;`);
      return rows.reverse().map((row) => ({role: 'event', text: extractOpenCodeText(row.data)})).filter((item) => item.text);
    } catch {
      return [];
    }
  }

  async rename(session, title) { this.sql(this.dbPath, `update session set title=${sqlString(title)}, time_updated=${Date.now()} where id=${sqlString(session.id)} returning id;`); return {title, integrity: integrityCheck(this.dbPath)}; }
  async archive(session) { const backupPath = backupDb(this.dbPath); this.sql(this.dbPath, `update session set time_archived=${Date.now()} where id=${sqlString(session.id)} returning id;`); return {archived: true, backupPath, integrity: integrityCheck(this.dbPath)}; }
  async restore(session) { this.sql(this.dbPath, `update session set time_archived=null where id=${sqlString(session.id)} returning id;`); return {archived: false, integrity: integrityCheck(this.dbPath)}; }
  async move(session, target) {
    const project = this.sql(this.dbPath, `select id, worktree, name from project where id=${sqlString(target)} or lower(name)=lower(${sqlString(target)}) limit 1;`)[0];
    if (!project) throw new Error(`OpenCode project not found: ${target}`);
    const backupPath = backupDb(this.dbPath);
    this.sql(this.dbPath, `update session set project_id=${sqlString(project.id)}, directory=${sqlString(project.worktree || session.cwd || '')}, time_updated=${Date.now()} where id=${sqlString(session.id)} returning id;`);
    return {project, backupPath, integrity: integrityCheck(this.dbPath)};
  }
  async delete(session) { this.sql(this.dbPath, `delete from session where id=${sqlString(session.id)} returning id;`); return {deleted: true}; }
}

export async function loadAll(adapters) {
  const results = await Promise.all(adapters.map(async (adapter) => {
    try {
      return {adapter, sessions: await adapter.sessions(), error: null};
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

function groupOpenCodeParts(rows) {
  const messages = [];
  for (const row of rows) {
    const previous = messages.at(-1);
    if (previous?.messageId === row.message_id) previous.text += `\n${row.text}`;
    else messages.push({messageId: row.message_id, role: row.role || 'event', text: row.text});
  }
  return messages.map(({role, text}) => ({role, text}));
}
