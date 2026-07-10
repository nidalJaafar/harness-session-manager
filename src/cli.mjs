import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DEFAULT_OPENCODE_DB} from './adapters.mjs';
import {scanHarnessProcesses} from './live.mjs';
import {StateStore} from './state.mjs';

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude/settings.json');
const OPENCODE_PLUGIN = path.join(os.homedir(), '.config/opencode/plugins/hsm.mjs');
const PI_EXTENSION = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'extensions/hsm.ts');
const LEGACY_HOOK_MARKER = 'hsm event';

function hsmExecutable() {
  try { return fs.realpathSync(process.argv[1]); } catch { return 'hsm'; }
}

export async function runSubcommand(args, {store = new StateStore(), stdin = process.stdin} = {}) {
  const command = args[0];
  if (command === 'event') return ingestEvent(args.slice(1), store, stdin);
  if (command === 'hooks') return manageHooks(args[1]);
  if (command === 'doctor') return doctor({store, dbPath: flag(args, '--db', DEFAULT_OPENCODE_DB)});
  return false;
}

export function ensureHooksInstalled({status = hookStatus, install = installHooks} = {}) {
  if (process.env.HSM_DISABLE_AUTO_HOOKS === '1') return {installed: false, skipped: true};
  const current = status();
  if (current.claude && current.opencode && current.pi) return {installed: false, status: current};
  install();
  return {installed: true, status: status()};
}

async function ingestEvent(args, store, stdin) {
  let payload = {};
  if (args.includes('--stdin') || !stdin.isTTY) {
    const text = await readStream(stdin);
    if (text.trim()) payload = JSON.parse(text);
  }
  const event = store.appendEvent({
    harness: flag(args, '--harness', payload.harness),
    sessionId: flag(args, '--session', payload.session_id || payload.sessionID || payload.sessionId),
    type: flag(args, '--type', mapHookType(payload.hook_event_name || payload.type)),
    timestamp: Number(flag(args, '--timestamp', payload.timestamp || Date.now())),
    pid: flag(args, '--pid', payload.pid || process.ppid),
    cwd: flag(args, '--cwd', payload.cwd || payload.directory || ''),
    message: flag(args, '--message', payload.message || ''),
  });
  process.stdout.write(`${JSON.stringify(event)}\n`);
  return true;
}

function manageHooks(action = 'status') {
  if (action === 'status') {
    const status = hookStatus();
    console.log(`Claude hooks: ${status.claude ? 'installed' : 'not installed'}`);
    console.log(`OpenCode plugin: ${status.opencode ? 'installed' : 'not installed'}`);
    console.log(`Pi extension: ${status.pi ? 'installed' : 'not installed'}`);
    return true;
  }
  if (action === 'install') {
    installHooks();
    console.log('Installed HSM lifecycle integration for Claude Code, OpenCode, and Pi.');
    return true;
  }
  if (action === 'remove') {
    removeClaudeHooks();
    if (fs.existsSync(OPENCODE_PLUGIN)) { backupFile(OPENCODE_PLUGIN); fs.unlinkSync(OPENCODE_PLUGIN); }
    if (fs.existsSync(PI_EXTENSION)) { backupFile(PI_EXTENSION); fs.unlinkSync(PI_EXTENSION); }
    console.log('Removed HSM lifecycle integrations.');
    return true;
  }
  throw new Error('Usage: hsm hooks install|remove|status');
}

function installHooks() {
  installClaudeHooks();
  installOpenCodePlugin();
  installPiExtension();
}

export function doctor({store = new StateStore(), dbPath = DEFAULT_OPENCODE_DB} = {}) {
  const checks = [];
  checks.push(checkCommand('claude'), checkCommand('opencode'), checkCommand('pi'), checkCommand('sqlite3'), checkCommand('bun'));
  checks.push({name: 'OpenCode DB', ok: fs.existsSync(dbPath), detail: dbPath});
  if (fs.existsSync(dbPath)) {
    try { const result = execFileSync('sqlite3', [dbPath, 'pragma integrity_check;'], {encoding: 'utf8'}).trim(); checks.push({name: 'OpenCode integrity', ok: result === 'ok', detail: result}); } catch (error) { checks.push({name: 'OpenCode integrity', ok: false, detail: error.message}); }
  }
  const hooks = hookStatus();
  checks.push({name: 'Claude hooks', ok: hooks.claude, detail: hooks.claude ? 'installed' : 'run hsm hooks install'});
  checks.push({name: 'OpenCode plugin', ok: hooks.opencode, detail: hooks.opencode ? 'installed' : 'run hsm hooks install'});
  checks.push({name: 'Pi extension', ok: hooks.pi, detail: hooks.pi ? 'installed' : 'run hsm hooks install'});
  let processes = [];
  try { processes = scanHarnessProcesses(); } catch {}
  checks.push({name: 'Harness processes', ok: true, detail: `${processes.length} detected`});
  checks.push({name: 'Event store', ok: true, detail: `${store.events().length} events · ${store.dir}`});
  console.log('HSM doctor');
  for (const check of checks) console.log(`${check.ok ? '✓' : '!'} ${check.name}: ${check.detail}`);
  return true;
}

function installClaudeHooks() {
  if (fs.existsSync(CLAUDE_SETTINGS)) backupFile(CLAUDE_SETTINGS);
  const settings = readJson(CLAUDE_SETTINGS, {});
  settings.hooks ||= {};
  const definitions = {SessionStart: 'started', UserPromptSubmit: 'running', PostToolUse: 'heartbeat', Notification: 'waiting', Stop: 'waiting', SessionEnd: 'completed'};
  const executable = shellQuote(hsmExecutable());
  for (const [hook, type] of Object.entries(definitions)) {
    const existing = (settings.hooks[hook] || []).filter((entry) => !isHsmHook(entry));
    existing.push({hooks: [{type: 'command', command: `${executable} event --stdin --harness claude --type ${type}`} ]});
    settings.hooks[hook] = existing;
  }
  writeJson(CLAUDE_SETTINGS, settings);
}

function removeClaudeHooks() {
  const settings = readJson(CLAUDE_SETTINGS, null);
  if (!settings?.hooks) return;
  backupFile(CLAUDE_SETTINGS);
  for (const hook of Object.keys(settings.hooks)) settings.hooks[hook] = settings.hooks[hook].filter((entry) => !isHsmHook(entry));
  writeJson(CLAUDE_SETTINGS, settings);
}

function installOpenCodePlugin() {
  if (fs.existsSync(OPENCODE_PLUGIN)) backupFile(OPENCODE_PLUGIN);
  fs.mkdirSync(path.dirname(OPENCODE_PLUGIN), {recursive: true});
  const executable = JSON.stringify(hsmExecutable());
  fs.writeFileSync(OPENCODE_PLUGIN, `import {spawn} from 'node:child_process';\n\nexport const HsmLifecycle = async ({directory}) => ({\n  event: async ({event}) => {\n    const sessionId = event.properties?.sessionID || event.properties?.sessionId || event.properties?.info?.id;\n    if (!sessionId) return;\n    const type = ({'session.created':'started','session.idle':'waiting','session.error':'failed','session.deleted':'completed'})[event.type] || (event.type?.startsWith('tool.') ? 'heartbeat' : null);\n    if (!type) return;\n    const child = spawn(${executable}, ['event','--harness','opencode','--session',sessionId,'--type',type,'--cwd',directory], {detached:true, stdio:'ignore'});\n    child.unref();\n  },\n});\n`, {mode: 0o600});
}

function installPiExtension() {
  if (fs.existsSync(PI_EXTENSION)) backupFile(PI_EXTENSION);
  fs.mkdirSync(path.dirname(PI_EXTENSION), {recursive: true});
  const executable = JSON.stringify(hsmExecutable());
  fs.writeFileSync(PI_EXTENSION, `import {spawn} from 'node:child_process';\nimport type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent';\n\nexport default function hsmLifecycle(pi: ExtensionAPI) {\n  const emit = (type: string, ctx: ExtensionContext) => {\n    const sessionId = ctx.sessionManager.getSessionId();\n    if (!sessionId) return;\n    const child = spawn(${executable}, ['event','--harness','pi','--session',sessionId,'--type',type,'--cwd',ctx.cwd,'--pid',String(process.pid)], {detached:true, stdio:'ignore'});\n    child.unref();\n  };\n  pi.on('session_start', async (_event, ctx) => emit('started', ctx));\n  pi.on('agent_start', async (_event, ctx) => emit('running', ctx));\n  pi.on('agent_end', async (_event, ctx) => emit('waiting', ctx));\n  pi.on('session_shutdown', async (_event, ctx) => emit('completed', ctx));\n}\n`, {mode: 0o600});
}

function hookStatus() { const settings = readJson(CLAUDE_SETTINGS, {}); return {claude: Object.values(settings.hooks || {}).flat().some(isHsmHook), opencode: fs.existsSync(OPENCODE_PLUGIN), pi: fs.existsSync(PI_EXTENSION)}; }
function isHsmHook(entry) { const text = JSON.stringify(entry); return text.includes(LEGACY_HOOK_MARKER) || (text.includes(' event --stdin ') && text.includes('--harness claude')); }
function checkCommand(command) { try { execFileSync('which', [command], {stdio: 'ignore'}); return {name: command, ok: true, detail: 'found'}; } catch { return {name: command, ok: false, detail: 'not found'}; } }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600}); }
function backupFile(file) { const target = `${file}.hsm-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`; fs.copyFileSync(file, target); return target; }
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function flag(args, name, fallback = '') { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; }
function mapHookType(type) { return ({SessionStart: 'started', UserPromptSubmit: 'running', PostToolUse: 'heartbeat', Notification: 'waiting', Stop: 'waiting', SessionEnd: 'completed'})[type] || type || 'heartbeat'; }
function readStream(stream) { return new Promise((resolve, reject) => { let data = ''; stream.setEncoding('utf8'); stream.on('data', (chunk) => { data += chunk; }); stream.on('end', () => resolve(data)); stream.on('error', reject); }); }
