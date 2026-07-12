import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DEFAULT_OPENCODE_DB} from './adapters.mjs';
import {scanHarnessProcesses} from './live.mjs';
import {StateStore} from './state.mjs';
import {HsmDaemon, runDaemon} from './daemon.mjs';
import {IntelligenceIndex} from './intelligence.mjs';
import {ProjectProfiles, WorktreeManager} from './projects.mjs';
import {RagLocator} from './rag.mjs';
import {DEFAULT_CODEX_DB,DEFAULT_CODEX_LOGS_DB} from './harnesses/codex.mjs';

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude/settings.json');
const OPENCODE_PLUGIN = path.join(os.homedir(), '.config/opencode/plugins/hsm.mjs');
const PI_EXTENSION = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'extensions/hsm.ts');
const LEGACY_HOOK_MARKER = 'hsm event';

function hsmExecutable() {
  try { return path.resolve(process.argv[1]); } catch { return 'hsm'; }
}

export async function runSubcommand(args, {store = new StateStore(), stdin = process.stdin} = {}) {
  const command = args[0];
  if (command === 'event') return ingestEvent(args.slice(1), store, stdin);
  if (command === 'hooks') return manageHooks(args[1]);
  if (command === 'doctor') return doctor({store, dbPath: flag(args, '--db', DEFAULT_OPENCODE_DB)});
  if (command === 'daemon') return manageDaemon(args.slice(1), store);
  if (command === 'profile') return manageProfiles(args.slice(1), store);
  if (command === 'worktree') return manageWorktrees(args.slice(1));
  if (command === 'index') return manageIndex(args.slice(1), store);
  if (command === 'search') return searchIndex(args.slice(1), store);
  if (command === 'ai') return manageAi(args.slice(1), store);
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
  checks.push(checkCommand('claude'), checkCommand('opencode'), checkCommand('pi'), checkCommand('codex'), checkCommand('sqlite3'), checkCommand('bun'));
  checks.push({name: 'OpenCode DB', ok: fs.existsSync(dbPath), detail: dbPath});
  checks.push({name:'Codex thread store',ok:fs.existsSync(DEFAULT_CODEX_DB),detail:DEFAULT_CODEX_DB});
  checks.push({name:'Codex live log',ok:fs.existsSync(DEFAULT_CODEX_LOGS_DB),detail:DEFAULT_CODEX_LOGS_DB});
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
  checks.push({name: 'HSM database', ok: store.integrity() === 'ok', detail: `${store.integrity()} · ${store.dbPath}`});
  const indexStatus = new IntelligenceIndex(store).status();
  checks.push({name: 'Local search index', ok: indexStatus.integrity === 'ok', detail: `${indexStatus.backend} · ${indexStatus.sessions} sessions · ${indexStatus.messages} messages`});
  const daemon = new HsmDaemon(store).status();
  checks.push({name: 'Background daemon', ok: true, detail: daemon.installed ? (daemon.active ? 'active' : 'installed, inactive') : 'optional, not installed'});
  checks.push(checkCommand('notify-send'), checkCommand('tmux'));
  console.log('HSM doctor');
  for (const check of checks) console.log(`${check.ok ? '✓' : '!'} ${check.name}: ${check.detail}`);
  return true;
}

async function manageDaemon(args, store) {
  const action=args[0]||'status'; if(action==='run'){await runDaemon(store);return true;}
  const daemon=new HsmDaemon(store); const result=action==='install'?daemon.install():action==='remove'?daemon.remove():action==='start'?daemon.start():action==='stop'?daemon.stop():action==='status'?daemon.status():null;
  if(!result)throw new Error('Usage: hsm daemon install|remove|start|stop|status'); console.log(`HSM daemon: ${result.installed?'installed':'not installed'} · ${result.active?'active':'inactive'}`);return true;
}
function manageProfiles(args,store){const action=args[0]||'list';const profiles=new ProjectProfiles(store);if(action==='list'){for(const item of profiles.list(flag(args,'--root','')))console.log(`${item.id}\t${item.name}\t${item.root}`);return true;}if(action==='create'){const root=flag(args,'--root',process.cwd()),name=flag(args,'--name',path.basename(root)),launches=JSON.parse(flag(args,'--launches','[]'));console.log(JSON.stringify(profiles.save({root,name,baseBranch:flag(args,'--base',''),launches,tmux:args.includes('--tmux')?{layout:flag(args,'--layout','tiled')}:null}),null,2));return true;}if(action==='edit'){const current=profiles.get(args[1]);if(!current)throw new Error(`Profile not found: ${args[1]}`);const patch=JSON.parse(fs.readFileSync(flag(args,'--file'),'utf8'));console.log(JSON.stringify(profiles.save({...current,...patch,id:current.id}),null,2));return true;}if(action==='duplicate'){console.log(JSON.stringify(profiles.duplicate(args[1],flag(args,'--name','Copy')),null,2));return true;}if(action==='export'){console.log(profiles.export(args[1],flag(args,'--output',`${args[1]}.hsm.json`)));return true;}if(action==='import'){const result=profiles.import(args[1],{confirm:args.includes('--yes')});console.log(JSON.stringify(result,null,2));return true;}if(action==='run'){console.log(JSON.stringify(profiles.run(args[1],{tmux:!args.includes('--no-tmux')}),null,2));return true;}throw new Error('Usage: hsm profile list|create|edit|duplicate|export|import|run');}
function manageWorktrees(args){const action=args[0]||'inspect',manager=new WorktreeManager(),root=flag(args,'--root',process.cwd());if(action==='inspect'){console.log(JSON.stringify(manager.inspect(root),null,2));return true;}if(action==='create'){console.log(JSON.stringify(manager.create({root,target:flag(args,'--target'),branch:flag(args,'--branch'),base:flag(args,'--base','HEAD'),confirm:args.includes('--yes')}),null,2));return true;}if(action==='cleanup'){const activeCwds=scanHarnessProcesses().map((item)=>item.cwd).filter(Boolean);console.log(JSON.stringify(manager.cleanup({root,target:flag(args,'--target'),confirm:args.includes('--yes'),activeCwds}),null,2));return true;}throw new Error('Usage: hsm worktree inspect|create|cleanup');}
async function manageIndex(args,store){const action=args[0]||'status',index=new IntelligenceIndex(store);if(action==='status'){console.log(JSON.stringify(index.status(),null,2));return true;}if(action==='pause'||action==='resume'){console.log(JSON.stringify(index.pause(action==='pause'),null,2));return true;}if(action==='exclude'){console.log(JSON.stringify(index.exclude(args[1]),null,2));return true;}if(action==='delete'){index.deleteSession(args[1]);console.log(`Deleted local index data for ${args[1]}`);return true;}if(action==='rebuild'){index.clear();const {createHarnessAdapters}=await import('./harnesses/index.mjs');const adapters=await createHarnessAdapters({});const sessions=(await Promise.all(adapters.map((adapter)=>adapter.sessions().catch(()=>[])))).flat();console.log(JSON.stringify(await index.indexSessions(sessions,adapters,{force:true}),null,2));return true;}throw new Error('Usage: hsm index status|rebuild|pause|resume|exclude|delete');}
function searchIndex(args,store){const query=args.join(' ');if(!query)throw new Error('Usage: hsm search <query>');for(const row of new IntelligenceIndex(store).search(query))console.log(`${row.harness}:${row.sessionId}\t${row.project}\t${row.role}\t${row.snippet}`);return true;}
async function manageAi(args,store){const action=args[0]||'status',locator=new RagLocator(new IntelligenceIndex(store));if(action==='status'){const configured=store.getKv('ai_provider')||'';console.log(`AI locator: ${locator.provider(configured||undefined)}${configured?' (configured)':' (auto)'}`);return true;}if(action==='provider'){const provider=args[1];locator.provider(provider);store.setKv('ai_provider',provider);console.log(`AI locator provider: ${provider}`);return true;}if(action==='find'){const query=args.slice(1).join(' ');if(!query)throw new Error('Usage: hsm ai find <query>');console.log(JSON.stringify(await locator.find(query,{provider:store.getKv('ai_provider')||undefined}),null,2));return true;}throw new Error('Usage: hsm ai status|provider <claude|pi>|find <query>');}

function installClaudeHooks() {
  if (fs.existsSync(CLAUDE_SETTINGS)) backupFile(CLAUDE_SETTINGS);
  const settings = readJson(CLAUDE_SETTINGS, {});
  settings.hooks ||= {};
  const definitions = {SessionStart: 'started', UserPromptSubmit: 'running', PostToolUse: 'heartbeat', PostToolUseFailure: 'failed', Notification: 'waiting', Stop: 'waiting', SessionEnd: 'completed'};
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
function mapHookType(type) { return ({SessionStart: 'started', UserPromptSubmit: 'running', PostToolUse: 'heartbeat', PostToolUseFailure: 'failed', Notification: 'waiting', Stop: 'waiting', SessionEnd: 'completed'})[type] || type || 'heartbeat'; }
function readStream(stream) { return new Promise((resolve, reject) => { let data = ''; stream.setEncoding('utf8'); stream.on('data', (chunk) => { data += chunk; }); stream.on('end', () => resolve(data)); stream.on('error', reject); }); }
