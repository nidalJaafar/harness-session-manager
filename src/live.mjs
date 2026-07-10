import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {sessionKey} from './state.mjs';

export const STATUS = {RUNNING: 'running', WAITING: 'waiting', COMPLETED: 'completed', FAILED: 'failed', STALE: 'stale', OFFLINE: 'offline'};
const ACTIVE_TTL = 5 * 60 * 1000;

export function scanHarnessProcesses({exec = defaultProcessList} = {}) {
  const found = [];
  for (const row of exec()) {
    const executable = String(row.executable || row.command.split(/\s+/)[0] || '').split('/').pop().toLowerCase();
    const harness = executable === 'pi' ? 'pi' : executable.includes('opencode') ? 'opencode' : executable.includes('claude') ? 'claude' : '';
    if (!harness) continue;
    const id = extractSessionId(row.command, harness);
    found.push({harness, sessionId: id, pid: row.pid, cwd: processCwd(row.pid)});
  }
  return found;
}

export function applyLiveState(sessions, events, processes, now = Date.now()) {
  const eventByKey = new Map();
  for (const event of events) if (!eventByKey.has(sessionKey(event.harness, event.sessionId))) eventByKey.set(sessionKey(event.harness, event.sessionId), event);
  const processByExact = new Map(processes.filter((item) => item.sessionId).map((item) => [sessionKey(item.harness, item.sessionId), item]));
  for (const process of processes.filter((item) => !item.sessionId && item.cwd)) {
    const candidate = sessions.filter((session) => session.harness === process.harness && samePath(session.cwd, process.cwd) && !session.isSubagent).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (candidate && !processByExact.has(sessionKey(candidate))) processByExact.set(sessionKey(candidate), process);
  }
  const processesByHarness = new Map();
  for (const item of processes) processesByHarness.set(item.harness, [...(processesByHarness.get(item.harness) || []), item]);
  return sessions.map((session) => {
    const key = sessionKey(session);
    const event = eventByKey.get(key);
    const process = processByExact.get(key) || ((processesByHarness.get(session.harness) || []).length === 1 && event?.pid === (processesByHarness.get(session.harness) || [])[0].pid ? processesByHarness.get(session.harness)[0] : null);
    const derived = deriveStatus({event, process, now});
    return {...session, status: derived.status, statusUpdatedAt: event?.timestamp || session.updatedAt, pid: process?.pid || event?.pid || null};
  });
}

export function deriveStatus({event, process, now = Date.now()}) {
  if (!event) return {status: process ? STATUS.RUNNING : STATUS.OFFLINE};
  if (event.type === 'failed' || event.type === 'error') return {status: STATUS.FAILED};
  if (event.type === 'waiting' || event.type === 'notification') return {status: process ? STATUS.WAITING : STATUS.STALE};
  if (event.type === 'completed' || event.type === 'stopped' || event.type === 'session-end') return {status: STATUS.COMPLETED};
  if (['running', 'started', 'heartbeat', 'tool'].includes(event.type)) return {status: process && now - event.timestamp <= ACTIVE_TTL ? STATUS.RUNNING : STATUS.STALE};
  return {status: process ? STATUS.RUNNING : STATUS.OFFLINE};
}

function defaultProcessList() {
  const output = execFileSync('ps', ['-eo', 'pid=,comm=,args='], {encoding: 'utf8'});
  return output.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^(\d+)\s+(\S+)\s+(.+)$/);
    return match ? {pid: Number(match[1]), executable: match[2], command: match[3]} : null;
  }).filter(Boolean);
}
function processCwd(pid) { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return ''; } }
function extractSessionId(command, harness) { const pattern = harness === 'claude' ? /--resume\s+([\w-]+)/i : harness === 'pi' ? /(?:--session|--session-id)\s+([\w-]+)/i : /(?:-s|--session)\s+([\w-]+)/i; return command.match(pattern)?.[1] || ''; }
function samePath(left, right) { try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return left === right; } }
