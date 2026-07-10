import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export const DEFAULT_PI_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');

export class PiAdapter {
  constructor({agentDir = DEFAULT_PI_DIR, sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR} = {}) {
    this.id = 'pi';
    this.name = 'Pi';
    this.newSession = {command: 'pi', args: []};
    this.agentDir = agentDir;
    this.sessionDir = sessionDir || readConfiguredSessionDir(agentDir) || path.join(agentDir, 'sessions');
  }

  available() { return fs.existsSync(this.sessionDir) || commandExists('pi'); }

  async sessions() {
    if (!fs.existsSync(this.sessionDir)) return [];
    return sessionFiles(this.sessionDir).map((file) => parsePiSession(file)).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async preview(session) {
    const parsed = readJsonLines(session.raw.file);
    return parsed.filter((entry) => entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role))
      .map((entry) => ({role: entry.message.role, text: contentText(entry.message.content)})).filter((message) => message.text).slice(-8);
  }
  async messagesSince(session) { return this.preview(session); }
  projectIdentity(session) { return session.cwd || session.project; }
  prepareLaunch({cwd}) { return {...this.newSession, cwd}; }

  async rename(session, title) {
    const entry = {type: 'session_info', id: randomId(), parentId: latestEntryId(session.raw.file), timestamp: new Date().toISOString(), name: title};
    fs.appendFileSync(session.raw.file, `${JSON.stringify(entry)}\n`);
    return {title};
  }
}

function parsePiSession(file) {
  try {
    const entries = readJsonLines(file);
    const header = entries.find((entry) => entry.type === 'session');
    if (!header?.id) return null;
    const messages = entries.filter((entry) => entry.type === 'message');
    const names = entries.filter((entry) => entry.type === 'session_info' && entry.name);
    const userText = messages.map((entry) => entry.message).filter((message) => message?.role === 'user').map((message) => contentText(message.content)).find((text) => text && text !== '/exit');
    const assistant = messages.map((entry) => entry.message).filter((message) => message?.role === 'assistant');
    const modelChanges = entries.filter((entry) => entry.type === 'model_change');
    const model = modelChanges.at(-1)?.modelId || assistant.at(-1)?.model || '';
    const provider = modelChanges.at(-1)?.provider || assistant.at(-1)?.provider || '';
    const usage = assistant.reduce((total, message) => ({tokens: total.tokens + Number(message.usage?.totalTokens || 0), cost: total.cost + Number(message.usage?.cost?.total || 0)}), {tokens: 0, cost: 0});
    const stat = fs.statSync(file);
    const cwd = header.cwd || '';
    const title = names.at(-1)?.name || summarize(userText) || `Pi session · ${path.basename(cwd) || header.id.slice(0, 8)}`;
    return {
      id: header.id, harness: 'pi', harnessName: 'Pi', title, project: path.basename(cwd) || 'Unknown', cwd,
      branch: gitBranch(cwd), tag: '', isSubagent: Boolean(header.parentSession), parentId: header.parentSession || '',
      model: provider && model ? `${provider}/${model}` : model, agent: '', cost: usage.cost,
      tokens: {input: usage.tokens, output: 0, reasoning: 0}, git: gitInfo(cwd),
      capabilities: {rename: true, tag: false, archive: false, delete: false, move: false, preview: true, cost: true, git: true, liveEvents: true},
      createdAt: Date.parse(header.timestamp) || stat.birthtimeMs, updatedAt: stat.mtimeMs,
      resume: {command: 'pi', args: ['--session', header.id]}, raw: {file, header},
    };
  } catch { return null; }
}

function sessionFiles(root) { const files = []; const stack = [root]; while (stack.length) { const current = stack.pop(); for (const entry of safeEntries(current)) { const target = path.join(current, entry.name); if (entry.isDirectory()) stack.push(target); else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(target); } } return files; }
function safeEntries(dir) { try { return fs.readdirSync(dir, {withFileTypes: true}); } catch { return []; } }
function readJsonLines(file) { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); }
function contentText(content) { if (typeof content === 'string') return content.trim(); if (!Array.isArray(content)) return ''; return content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n').trim(); }
function summarize(value) { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > 100 ? `${text.slice(0, 99)}…` : text; }
function latestEntryId(file) { return readJsonLines(file).filter((entry) => entry.id).at(-1)?.id || null; }
function randomId() { return Math.random().toString(16).slice(2, 10); }
function commandExists(command) { try { execFileSync('which', [command], {stdio: 'ignore'}); return true; } catch { return false; } }
function readConfiguredSessionDir(agentDir) { try { return JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).sessionDir || ''; } catch { return ''; } }
function gitBranch(cwd) { try { return execFileSync('git', ['-C', cwd, 'branch', '--show-current'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); } catch { return ''; } }
function gitInfo(cwd) { try { const rows = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim().split('\n').filter(Boolean); return {branch: gitBranch(cwd), dirty: rows.length > 0, files: rows.length}; } catch { return {branch: '', dirty: false, files: 0}; } }
