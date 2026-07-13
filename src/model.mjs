import fs from 'node:fs';
import {execFileSync, spawn} from 'node:child_process';
import {loadAll} from './adapters.mjs';
import {applyLiveState, scanHarnessProcesses, STATUS} from './live.mjs';
import {StateStore, sessionKey} from './state.mjs';
import {IntelligenceIndex} from './intelligence.mjs';
import {ProjectProfiles, WorktreeManager} from './projects.mjs';
import {RagLocator} from './rag.mjs';
import {UpdateManager} from './update.mjs';

export class SessionHubModel {
  constructor({adapters = [], openMode = process.env.HSM_OPEN_MODE || 'terminal', store = new StateStore(), processScanner = scanHarnessProcesses, showSubagents = undefined} = {}) {
    this.adapters = adapters;
    this.openMode = openMode;
    this.store = store;
    this.processScanner = processScanner;
    this.index = new IntelligenceIndex(store);
    this.profiles = new ProjectProfiles(store);
    this.worktrees = new WorktreeManager();
    this.rag = new RagLocator(this.index);
    this.updates = new UpdateManager(store);
    this.updateInfo = this.updates.cached();
    this.width = 120;
    this.height = 36;
    this.focus = 'sessions';
    this.source = this.store.state.ui?.source || 'all';
    this.query = '';
    this.showSubagents = showSubagents ?? (process.env.HSM_SHOW_SUBAGENTS == null ? this.store.state.ui?.showSubagents ?? false : process.env.HSM_SHOW_SUBAGENTS === '1');
    this.view = ['dashboard', 'projects'].includes(this.store.state.ui?.view) ? this.store.state.ui.view : this.store.state.ui?.view === 'browser' ? 'projects' : 'dashboard';
    this.finderReturnView = this.view;
    this.finderReturnQuery = this.query;
    this.viewMode = 'folders';
    this.sessions = [];
    this.sources = [];
    this.filtered = [];
    this.selectedSource = 0;
    this.selectedSession = 0;
    this.scroll = 0;
    this.collapsedFolders = new Set();
    this.collapseInitialized = false;
    this.prompt = false;
    this.promptValue = '';
    this.preview = [];
    this.searchResults = [];
    this.aiResults = [];
    this.searchMode = 'local';
    this.finderPromptMode = 'local';
    this.aiProvider = '';
    this.projectSummaries = new Map();
    this.relatedCache = new Map();
    this.events = [];
    this.palette = false;
    this.paletteQuery = '';
    this.paletteIndex = 0;
    this.paletteMessage = '';
    this.help = false;
    this.launcher = false;
    this.launcherIndex = 0;
    this.promptKind = 'search';
    this.pendingAction = null;
    this.lastDiscoveryRefresh = 0;
    this.status = 'Discovering sessions…';
  }

  async load() {
    const data = await loadAll(this.adapters);
    this.events = this.store.events();
    const processes = this.safeProcesses();
    this.sessions = applyLiveState(data.sessions.map((session) => mergeMetadata(session, this.store.metadata(sessionKey(session)))), this.events, processes)
      .filter((session) => !session.local.hidden);
    this.relatedCache.clear();
    this.indexWarning = '';
    try { await this.index.indexSessions(this.sessions, this.adapters); } catch (error) { this.indexWarning = `Index deferred: ${shortError(error)}`; }
    this.refreshProjectSummaries(8);
    if (!this.collapseInitialized) {
      const expanded = new Set(this.store.state.ui?.expandedFolders || []);
      for (const session of this.sessions) if (!expanded.has(folderKey(session))) this.collapsedFolders.add(folderKey(session));
      this.collapseInitialized = true;
    }
    this.sources = [{id: 'all', name: 'All harnesses', count: this.sessions.length, available: true}, ...data.sources];
    this.selectedSource = Math.max(0, this.sources.findIndex((source) => source.id === this.source));
    if (!this.sources[this.selectedSource]) { this.selectedSource = 0; this.source = 'all'; }
    this.recompute();
    const restoredSelection = this.store.state.ui?.selections?.[this.view];
    this.selectedSession = Number.isInteger(restoredSelection) ? clamp(restoredSelection, 0, Math.max(0, this.rows().length - 1)) : Math.max(0, this.rows().findIndex((row) => row.type === 'session'));
    const errors = data.sources.filter((source) => source.error);
    this.status = errors.length ? `Loaded ${this.sessions.length} sessions · ${errors.map((source) => `${source.name}: ${source.error}`).join(' · ')}` : `Synced ${this.sessions.length} sessions across ${data.sources.filter((source) => source.available).length} harnesses${this.indexWarning ? ` · ${this.indexWarning}` : ''}`;
  }

  safeProcesses() {
    let processes = [];
    try { processes = this.processScanner(); } catch {}
    for (const adapter of this.adapters) {
      if (typeof adapter.processes !== 'function') continue;
      try { processes.push(...adapter.processes()); } catch {}
    }
    const seen = new Set();
    return processes.filter((process) => { const key = `${process.harness}:${process.pid}:${process.sessionId || ''}`; if (seen.has(key)) return false; seen.add(key); return true; });
  }

  async refreshLive(now = Date.now()) {
    this.events = this.store.events();
    const known = new Set(this.sessions.map((session) => sessionKey(session)));
    const hasNewActiveSession = this.events.some((event) => now - event.timestamp < ACTIVE_DISCOVERY_WINDOW && ['started', 'running', 'waiting', 'heartbeat', 'tool', 'notification'].includes(event.type) && !known.has(sessionKey(event.harness, event.sessionId)));
    if (hasNewActiveSession && now - this.lastDiscoveryRefresh >= DISCOVERY_RETRY_INTERVAL) {
      this.lastDiscoveryRefresh = now;
      const selected = this.selected();
      const selectedKey = selected ? sessionKey(selected) : '';
      await this.load();
      if (selectedKey) {
        const index = this.rows().findIndex((row) => row.session && sessionKey(row.session) === selectedKey);
        if (index >= 0) this.selectedSession = index;
      }
      this.status = `Discovered new session · ${this.status}`;
      return;
    }
    this.sessions = applyLiveState(this.sessions, this.events, this.safeProcesses());
    this.recompute();
  }

  async checkForUpdates(){this.updateInfo=await this.updates.check();this.onStatus?.();return this.updateInfo;}

  recompute() {
    const query = this.query.trim().toLowerCase();
    const matching = this.sessions.filter((session) => this.showSubagents || !session.isSubagent).filter((session) => this.source === 'all' || session.harness === this.source).filter((session) => !query || [session.title, session.project, session.cwd, session.branch, session.tag, session.local?.tag, session.local?.note, session.id, session.harnessName].join(' ').toLowerCase().includes(query));
    this.filtered = this.viewMode === 'folders' ? sortByFolderActivity(matching) : matching;
    this.selectedSession = clamp(this.selectedSession, 0, Math.max(0, this.rows().length - 1));
    this.ensureVisible();
  }

  async key(key) {
    if (this.help) { if (key === '?' || key === 'esc' || key === 'q' || key === 'ctrl+c') this.help = false; return; }
    if (this.launcher) return this.launcherKey(key);
    if (this.palette) return this.paletteKey(key);
    if (this.prompt) return this.promptKey(key);
    if (key === 'q' || key === 'ctrl+c') return 'quit';
    if (key === '?') this.help = true;
    else if (key === '1') this.setView('dashboard');
    else if (key === '2') this.setView('projects');
    else if (key === 'A' && this.view === 'search') await this.openGlobalSessionFinder('ai');
    else if (key === 'ctrl+k') this.openPalette();
    else if (key === 'n') this.openLauncher();
    else if (key === 'tab' || key === 'f') this.cycleSource();
    else if (key === 'j' || key === 'down') this.move(1);
    else if (key === 'k' || key === 'up') this.move(-1);
    else if (key === 'pageup') this.move(-10);
    else if (key === 'pagedown') this.move(10);
    else if (key === '/') { if(this.view==='search'){this.prompt=true;this.promptKind='search';this.promptValue=this.query;this.finderPromptMode='local';}else this.openSessionFinder(true,'local'); }
    else if (key === 'r') await this.load();
    else if (key === 'g') { this.viewMode = this.viewMode === 'folders' ? 'recent' : 'folders'; this.selectedSession = 0; this.scroll = 0; this.preview = []; this.recompute(); this.status = this.viewMode === 'folders' ? 'Grouped by working folder' : 'Showing global recent activity'; }
    else if (key === 'enter') {
      if (this.selectedRow()?.type === 'folder') this.toggleSelectedFolder();
      else if (this.selectedRow()?.type === 'lane') this.toggleLane(this.selectedRow().lane);
      else await this.previewSelected();
    }
    else if (key === 'v') await this.previewSelected();
    else if (key === 'right' && this.selectedRow()?.type === 'folder') this.expandSelectedFolder();
    else if (key === 'left' && this.selectedRow()?.type === 'folder') this.collapseSelectedFolder();
    else if (key === 'o') return this.openSelected();
    else if (key === 'p') this.togglePin();
    else if (key === 'z') this.snoozeSelected(60 * 60 * 1000);
    else if (key === 'w') this.wakeSelected();
    else if (key === 'l') this.returnToLatestSession();
    else if (key === 's') this.toggleSubagents();
    else if (key === 'u') await this.undoLatest();
    else if (key === 'h') this.status = this.commandHint();
    else if (key === 'esc' && this.view === 'search') this.closeSessionFinder();
    else if (key === 'esc' && this.preview.length) { this.preview = []; this.status = 'Preview closed'; }
  }

  async promptKey(key) {
    if (key === 'esc' || key === 'ctrl+c') { this.prompt = false; return; }
    if (key === 'enter') {
      this.prompt = false;
      const value = this.promptValue.trim();
      if (this.promptKind === 'search') { this.query = value; this.store.setUi({finderQuery: value}); this.selectedSession = 0; this.preview = []; this.runLocalSearch(); this.status = value ? `Local results: ${value}` : 'Finder query cleared'; if(value&&this.finderPromptMode==='ai'){this.finderPromptMode='local';return this.askAiToLocate();}this.finderPromptMode='local'; }
      else return this.completePrompt(value);
      return;
    }
    if (key === 'backspace') this.promptValue = this.promptValue.slice(0, -1);
    else if (key === 'space') this.promptValue += ' ';
    else if (key.length === 1) this.promptValue += key;
  }

  move(delta) {
    if (this.focus === 'sources') {
      this.selectedSource = clamp(this.selectedSource + delta, 0, Math.max(0, this.sources.length - 1));
      this.source = this.sources[this.selectedSource]?.id || 'all';
      this.selectedSession = 0;
      this.preview = [];
      this.recompute();
    } else {
      this.selectedSession = clamp(this.selectedSession + delta, 0, Math.max(0, this.rows().length - 1));
      this.preview = [];
      this.ensureVisible();
      this.persistSelection();
    }
  }

  cycleSource() {
    if (!this.sources.length) return;
    this.selectedSource = (this.selectedSource + 1) % this.sources.length;
    this.source = this.sources[this.selectedSource].id;
    this.selectedSession = 0;
    this.scroll = 0;
    this.preview = [];
    this.recompute();
    this.store.setUi({source: this.source});
    this.status = `Showing ${this.sources[this.selectedSource].name}`;
  }

  async previewSelected() {
    const session = this.selected();
    if (!session) return;
    const adapter = this.adapters.find((item) => item.id === session.harness);
    this.preview = await adapter.preview(session);
    session.lastRequest = [...this.preview].reverse().find((message) => message.role === 'user')?.text || '';
    session.lastResponse = [...this.preview].reverse().find((message) => message.role === 'assistant' || message.role === 'event')?.text || '';
    this.status = this.preview.length ? `Previewing ${session.harnessName} session` : `No message preview available · ${this.commandHint()}`;
  }

  openSelected() {
    const session = this.selected();
    if (!session) return;
    return this.launchSession(session);
  }

  launchSession(session) {
    const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : process.cwd();
    this.store.updateSession(sessionKey(session), {lastOpenedAt: Date.now()});
    this.store.setUi({latestSession: sessionKey(session)});
    if (this.openMode === 'tty') return {type: 'open', ...session.resume, cwd};
    const [terminal, ...terminalArgs] = (process.env.TERMINAL || 'xdg-terminal-exec').split(/\s+/);
    const child = spawn(terminal, [...terminalArgs, session.resume.command, ...session.resume.args], {cwd, detached: true, stdio: 'ignore'});
    child.unref();
    this.status = `Launched ${session.harnessName} · ${this.commandHint()}`;
  }

  queueRows() {
    if (this.viewMode !== 'folders') return this.filtered.map((session) => ({type: 'session', session}));
    const groups = new Map();
    for (const session of this.filtered) {
      const key = folderKey(session);
      const group = groups.get(key) || {key, sessions: []};
      group.sessions.push(session);
      groups.set(key, group);
    }
    const rows = [];
    for (const group of groups.values()) {
      rows.push({type: 'folder', key: group.key, sessions: group.sessions, summary: this.projectSummaries.get(group.key), collapsed: this.collapsedFolders.has(group.key)});
      if (!this.collapsedFolders.has(group.key)) rows.push(...group.sessions.map((session, index) => ({type: 'session', session, folder: group.key, isLast: index === group.sessions.length - 1})));
    }
    return rows;
  }

  rows() {
    if (this.view === 'projects') return this.queueRows();
    if (this.view === 'search') { const results=this.searchMode==='ai'?this.aiResults:this.searchResults;return results.map((result) => ({type: this.searchMode==='ai'?'ai-search':'search', result, session: this.sessions.find((session) => sessionKey(session) === result.sessionKey)})); }
    return this.dashboardRows();
  }

  dashboardRows() {
    const pinned = this.filtered.filter((session) => session.local.pinned);
    const lanes = [
      ['waiting', this.filtered.filter((session) => session.status === STATUS.WAITING && Number(session.local.snoozedUntil || 0) <= Date.now())],
      ['running', this.filtered.filter((session) => session.status === STATUS.RUNNING)],
      ['pinned', pinned],
      ['snoozed', this.filtered.filter((session) => Number(session.local.snoozedUntil || 0) > Date.now())],
      ['recent', this.filtered.filter((session) => !pinned.includes(session)).sort((a, b) => Number(b.local.lastOpenedAt || 0) - Number(a.local.lastOpenedAt || 0) || b.updatedAt - a.updatedAt).slice(0, 12)],
    ];
    const rows = [];
    for (const [lane, sessions] of lanes) {
      rows.push({type: 'lane', lane, count: sessions.length});
      if (!this.collapsedFolders.has(`lane:${lane}`)) rows.push(...sessions.map((session) => ({type: 'session', session, lane})));
    }
    return rows;
  }

  selectedRow() { return this.rows()[this.selectedSession] || null; }
  selected() { return this.selectedRow()?.session || null; }
  toggleSelectedFolder() { const row = this.selectedRow(); if (row?.type !== 'folder') return; if (this.collapsedFolders.has(row.key)) this.collapsedFolders.delete(row.key); else this.collapsedFolders.add(row.key); this.persistExpanded(); this.preview = []; this.status = `${this.collapsedFolders.has(row.key) ? 'Collapsed' : 'Expanded'} ${row.key}`; this.ensureVisible(); }
  expandSelectedFolder() { const row = this.selectedRow(); if (row?.type === 'folder') { this.collapsedFolders.delete(row.key); this.status = `Expanded ${row.key}`; } }
  collapseSelectedFolder() { const row = this.selectedRow(); if (row?.type === 'folder') { this.collapsedFolders.add(row.key); this.status = `Collapsed ${row.key}`; } }
  commandHint() { const s = this.selected(); return s ? `${s.resume.command} ${s.resume.args.join(' ')}` : 'No session selected'; }
  ensureVisible() { const rows = Math.max(2, Math.floor((this.height - 14) / 2)); if (this.selectedSession < this.scroll) this.scroll = this.selectedSession; if (this.selectedSession >= this.scroll + rows) this.scroll = this.selectedSession - rows + 1; }

  setView(view) { view = view === 'browser' ? 'projects' : view; if(view==='search')return this.openSessionFinder(false);this.view = view; this.selectedSession = Number(this.store.state.ui?.selections?.[view] || 0); this.scroll = 0; this.preview = []; this.store.setUi({view}); this.recompute(); this.status = `${view[0].toUpperCase()}${view.slice(1)} view`; }
  toggleLane(lane) { const key = `lane:${lane}`; if (this.collapsedFolders.has(key)) this.collapsedFolders.delete(key); else this.collapsedFolders.add(key); this.status = `${this.collapsedFolders.has(key) ? 'Collapsed' : 'Expanded'} ${lane}`; }
  persistExpanded() { const expanded = [...new Set(this.sessions.map(folderKey))].filter((key) => !this.collapsedFolders.has(key)); this.store.setUi({expandedFolders: expanded}); }
  persistSelection() { const selections = {...this.store.state.ui?.selections, [this.view]: this.selectedSession}; this.store.setUi({selections}); }
  togglePin() { const session = this.selected(); if (!session) return; const pinned = !session.local.pinned; this.store.updateSession(sessionKey(session), {pinned}); session.local.pinned = pinned; this.recordAction(session, pinned ? 'pinned' : 'unpinned'); this.recompute(); this.status = `${pinned ? 'Pinned' : 'Unpinned'} ${session.title}`; }
  snoozeSelected(duration) { const session = this.selected(); if (!session) return; const until = Date.now() + duration; this.store.updateSession(sessionKey(session), {snoozedUntil: until}); session.local.snoozedUntil = until; this.recompute(); this.status = `Snoozed until ${new Date(until).toLocaleTimeString()}`; }
  wakeSelected() { const session = this.selected(); if (!session) return; this.store.updateSession(sessionKey(session), {snoozedUntil: 0}); session.local.snoozedUntil = 0; this.recompute(); this.status = `Woke ${session.title}`; }
  returnToLatestSession() { const key = this.store.state.ui?.latestSession || this.store.state.ui?.mission; const session = this.sessions.find((item) => sessionKey(item) === key); if (!session) { this.status = 'No latest session is available'; return; } this.setView('projects'); this.query = session.id; this.collapsedFolders.delete(folderKey(session)); this.recompute(); this.selectedSession = this.rows().findIndex((row) => row.session?.id === session.id); this.persistSelection(); this.status = `Selected latest session · ${session.title}`; }
  toggleSubagents() { this.showSubagents = !this.showSubagents; this.store.setUi({showSubagents: this.showSubagents}); this.selectedSession = 0; this.scroll = 0; this.preview = []; this.recompute(); this.status = `${this.showSubagents ? 'Showing' : 'Hiding'} subagent threads`; }
  openPalette() { this.palette = true; this.paletteQuery = ''; this.paletteIndex = 0; this.paletteMessage = ''; }
  paletteItems() {
    const session = this.selected();
    const root = this.selectedProjectRoot();
    const profiles = root ? this.profiles.list(root) : [];
    const selectReason = 'Select a session row first';
    const actions = [
      action('new-session', 'New session…', this.launchableAdapters().length > 0, 'No installed harness declares new-session support'), action('search-index','Search local transcripts…',true), action('ai-locate',this.searchMode==='ai'?'Show local search results':'Ask AI to locate session',Boolean(this.view==='search'&&this.query),'Open Search and enter a query first'), action('profile-create','Create launch profile…',Boolean(root),'Select a project or session first'), action('profile-run',profiles.length?`Run profile: ${profiles[0].name}`:'Run project profile',profiles.length>0,root?'Project has no launch profile':'Select a project first'), action('worktree-inspect','Inspect project worktrees',Boolean(root),'Select a project first'), action('worktree-create','Create Git worktree…',Boolean(root),'Select a project first'), action('latest-session', 'Go to latest session', Boolean(this.store.state.ui?.latestSession || this.store.state.ui?.mission), 'No latest session'), action('snooze', 'Snooze for one hour', Boolean(session), selectReason), action('wake', 'Wake now', Boolean(session?.local?.snoozedUntil), session ? 'Session is not snoozed' : selectReason), action('subagents', this.showSubagents ? 'Hide subagent threads' : 'Show subagent threads', true), action('continue', 'Continue where I left off', Boolean(this.continueSession())), action('resume', 'Resume session', Boolean(session), selectReason), action('pin', session?.local.pinned ? 'Unpin session' : 'Pin session', Boolean(session), selectReason),
      action('alias', 'Set local alias', Boolean(session), selectReason), action('tag', 'Set session tag', Boolean(session), selectReason), action('note', 'Add note', Boolean(session), selectReason), action('copy', 'Copy resume command', Boolean(session), selectReason),
      action('folder', 'Open working folder', Boolean(session?.cwd), session ? 'Session has no working folder' : selectReason), action('editor', 'Open in editor', Boolean(session?.cwd), session ? 'Session has no working folder' : selectReason),
      action('rename', 'Rename session', Boolean(session?.capabilities?.rename), session ? 'Harness does not support rename' : selectReason), action('move', 'Move to OpenCode project', Boolean(session?.capabilities?.move), session ? 'Only OpenCode sessions can move projects' : selectReason), action('archive', 'Archive session', Boolean(session?.capabilities?.archive), session ? 'Local hide is available instead' : selectReason),
      action('hide', 'Hide from HSM', Boolean(session), selectReason), action('delete', 'Delete session', Boolean(session?.capabilities?.delete), session ? 'Harness does not support safe deletion' : selectReason),
    ];
    const sessions = this.sessions.filter((item) => (this.showSubagents || !item.isSubagent) && (this.source === 'all' || item.harness === this.source)).slice(0, 100).map((item) => ({id: `jump:${sessionKey(item)}`, label: `${item.local.alias || item.title} · ${item.harnessName}`, enabled: true, session: item}));
    const query = this.paletteQuery.toLowerCase();
    return [...actions, ...sessions].filter((item) => fuzzy(item.label.toLowerCase(), query)).sort((a, b) => fuzzyScore(b.label.toLowerCase(), query) - fuzzyScore(a.label.toLowerCase(), query));
  }
  async paletteKey(key) { if (key === 'esc' || key === 'ctrl+c') { this.palette = false; return; } const items = this.paletteItems(); if (key === 'up') { this.paletteIndex = clamp(this.paletteIndex - 1, 0, Math.max(0, items.length - 1)); this.paletteMessage = ''; } else if (key === 'down') { this.paletteIndex = clamp(this.paletteIndex + 1, 0, Math.max(0, items.length - 1)); this.paletteMessage = ''; } else if (key === 'backspace') { this.paletteQuery = this.paletteQuery.slice(0, -1); this.paletteIndex = 0; this.paletteMessage = ''; } else if (key === 'enter') { const item = items[this.paletteIndex]; if (!item?.enabled) { this.paletteMessage = item.reason || 'This action is unavailable for the current selection.'; this.status = this.paletteMessage; } else return this.runPaletteAction(item); } else if (key.length === 1) { this.paletteQuery += key; this.paletteIndex = 0; this.paletteMessage = ''; } }
  async runPaletteAction(item) {
    this.palette = false;
    if (item.session) { this.setView('projects'); this.query = item.session.id; this.recompute(); return; }
    if (item.id === 'new-session') return this.openLauncher();
    if (item.id === 'search-index') { this.openSessionFinder(); return; }
    if (item.id === 'ai-locate') return this.toggleAiSearch();
    if (item.id === 'profile-create') { this.prompt = true; this.promptKind = 'profile'; this.promptValue = `${this.selected()?.project || 'project'} workspace`; return; }
    if (item.id === 'profile-run') { const profile = this.profiles.list(this.selectedProjectRoot())[0]; const result = this.profiles.run(profile.id); this.status = `Launched ${profile.name} with ${result.backend}`; return; }
    if (item.id === 'worktree-inspect') { const rows = this.worktrees.inspect(this.selectedProjectRoot()); this.status = `${rows.length} worktrees · ${rows.filter((row) => row.dirty).length} dirty · ${rows.filter((row) => row.merged).length} merged`; return; }
    if (item.id === 'worktree-create') { const root = this.selectedProjectRoot(); this.prompt = true; this.promptKind = 'worktree'; this.promptValue = `feature ../${pathName(root)}-feature`; return; }
    if (item.id === 'latest-session') return this.returnToLatestSession();
    if (item.id === 'snooze') return this.snoozeSelected(60 * 60 * 1000);
    if (item.id === 'wake') return this.wakeSelected();
    if (item.id === 'continue') return this.openSession(this.continueSession());
    if (item.id === 'subagents') return this.toggleSubagents();
    if (item.id === 'resume') return this.openSelected();
    if (item.id === 'pin') return this.togglePin();
    if (['alias', 'tag', 'note', 'rename', 'move'].includes(item.id)) {
      this.prompt = true; this.promptKind = item.id;
      this.promptValue = item.id === 'alias' ? this.selected().local.alias || '' : item.id === 'tag' ? this.selected().tag || this.selected().local.tag || '' : item.id === 'note' ? this.selected().local.note || '' : item.id === 'rename' ? this.selected().title : '';
      return;
    }
    if (['archive', 'delete', 'hide'].includes(item.id)) { this.prompt = true; this.promptKind = 'confirm'; this.promptValue = ''; this.pendingAction = item.id; this.status = `Type yes to ${item.id} ${this.selected().title}`; return; }
    if (item.id === 'copy') return this.copyCommand();
    if (item.id === 'folder' || item.id === 'editor') return this.openPath(item.id);
  }
  async completePrompt(value) {
    if (this.promptKind === 'new-session') return this.launchNewSession(this.pendingAction, value);
    if (this.promptKind === 'worktree') { const [branch, target] = value.split(/\s+/, 2); if (!branch || !target) { this.status = 'Enter: <new-branch> <target-path>'; return; } const data = {root:this.selectedProjectRoot(),branch,target}; const result=this.worktrees.create(data); this.pendingAction={kind:'worktree-create',data}; this.prompt=true;this.promptKind='confirm';this.promptValue='';this.status=`Type yes to create ${result.preview.target} from ${branch}`;return; }
    if (this.promptKind === 'profile') { const session=this.selected();const adapter=session&&this.adapters.find((item)=>item.id===session.harness);const launch=adapter?.newSession||{command:session?.resume?.command||'sh',args:[]};const profile=this.profiles.save({name:value,root:this.selectedProjectRoot(),launches:[{command:launch.command,args:launch.args||[]}],tmux:{layout:'tiled'}});this.refreshProjectSummaries();this.status=`Created profile ${profile.name}`;return; }
    if (this.promptKind === 'confirm' && this.pendingAction?.kind === 'worktree-create') { if(value!=='yes'){this.status='Action cancelled';return;}const result=this.worktrees.create({...this.pendingAction.data,confirm:true});this.pendingAction=null;this.status=`Created worktree ${result.target}`;return; }
    const session = this.selected(); if (!session) return;
    const adapter = this.adapters.find((item) => item.id === session.harness);
    if (this.promptKind === 'alias' || this.promptKind === 'note') { this.store.updateSession(sessionKey(session), {[this.promptKind]: value}); session.local[this.promptKind] = value; this.recordAction(session, `${this.promptKind}-updated`); this.status = `Saved local ${this.promptKind}`; return; }
    if (this.promptKind === 'tag') { if (session.capabilities?.tag && adapter.tag) { await adapter.tag(session, value); session.tag = value; } else { this.store.updateSession(sessionKey(session), {tag: value}); session.local.tag = value; } this.recordAction(session, 'tagged', value); this.status = `Tagged ${session.title} as ${value}`; return; }
    if (this.promptKind === 'rename') { await adapter.rename(session, value); this.store.recordUndo({type: 'rename', session: sessionKey(session), before: session.title, after: value}); this.recordAction(session, 'renamed', value); session.title = value; this.status = `Renamed to ${value}`; return; }
    if (this.promptKind === 'move') { const result = await adapter.move(session, value); this.store.recordUndo({type: 'move', session: sessionKey(session), before: session.projectId, after: result.project.id, backupPath: result.backupPath}); this.recordAction(session, 'moved', result.project.name || result.project.id); this.status = `Moved to ${result.project.name || result.project.worktree}`; return this.load(); }
    if (this.promptKind === 'confirm') { if (value !== 'yes') { this.status = 'Action cancelled'; return; } await this.destructiveAction(this.pendingAction, session); }
  }
  async destructiveAction(kind, session) {
    if (kind === 'hide') { this.store.updateSession(sessionKey(session), {hidden: true}); this.store.recordUndo({type: 'hide', session: sessionKey(session)}); this.recordAction(session, 'hidden'); this.status = `Hidden ${session.title}`; return this.load(); }
    const adapter = this.adapters.find((item) => item.id === session.harness);
    if (kind === 'archive') { const result = await adapter.archive(session); this.store.recordUndo({type: 'archive', session: sessionKey(session), backupPath: result.backupPath}); this.recordAction(session, 'archived'); this.status = `Archived ${session.title}`; return this.load(); }
    if (kind === 'delete') this.status = 'Delete is disabled because this adapter cannot provide session-scoped undo.';
  }
  async undoLatest() {
    const undo = this.store.latestUndo(); if (!undo) { this.status = 'Nothing to undo'; return; }
    const [harness, id] = undo.session.split(':');
    const session = this.sessions.find((item) => item.harness === harness && item.id === id) || {harness, id};
    const adapter = this.adapters.find((item) => item.id === harness);
    if (undo.type === 'archive' && adapter?.restore) await adapter.restore(session);
    else if (undo.type === 'rename' && adapter?.rename) await adapter.rename(session, undo.before);
    else if (undo.type === 'move' && adapter?.move) await adapter.move(session, undo.before);
    else if (undo.type === 'hide') this.store.updateSession(undo.session, {hidden: false});
    else { this.status = 'Latest action cannot be undone in the current session'; return; }
    this.status = `Undid ${undo.type}`; await this.load();
  }
  copyCommand() { const command = this.commandHint(); try { execFileSync('wl-copy', [], {input: command}); this.status = 'Resume command copied'; } catch { this.status = command; } }
  openPath(kind) { const session = this.selected(); const command = kind === 'editor' ? (process.env.EDITOR || 'code') : 'xdg-open'; const child = spawn(command, [session.cwd], {detached: true, stdio: 'ignore'}); child.unref(); this.status = `Opened ${session.cwd}`; }
  recordAction(session, type, message = '') { const event = this.store.appendEvent({harness: session.harness, sessionId: session.id, type, timestamp: Date.now(), cwd: session.cwd, message}); this.events.unshift(event); }
  continueSession() { return [...this.sessions].filter((session) => this.showSubagents || !session.isSubagent).sort((a, b) => Number(b.local.lastOpenedAt || 0) - Number(a.local.lastOpenedAt || 0) || b.updatedAt - a.updatedAt)[0] || null; }
  openSession(session) { return session ? this.launchSession(session) : undefined; }
  launchableAdapters() { return this.adapters.filter((adapter) => adapter.available() && adapter.newSession?.command); }
  openLauncher() { this.palette = false; this.launcher = true; this.launcherIndex = 0; this.status = 'Choose a harness for the new session'; }
  launcherKey(key) { const adapters = this.launchableAdapters(); if (key === 'esc' || key === 'ctrl+c') { this.launcher = false; return; } if (key === 'up' || key === 'k') this.launcherIndex = clamp(this.launcherIndex - 1, 0, Math.max(0, adapters.length - 1)); else if (key === 'down' || key === 'j') this.launcherIndex = clamp(this.launcherIndex + 1, 0, Math.max(0, adapters.length - 1)); else if (key === 'enter') { const adapter = adapters[this.launcherIndex]; if (!adapter) return; this.launcher = false; this.prompt = true; this.promptKind = 'new-session'; this.pendingAction = adapter.id; this.promptValue = this.defaultLaunchCwd(); } }
  defaultLaunchCwd() { const row = this.selectedRow(); if (row?.session?.cwd) return row.session.cwd; if (row?.type === 'folder' && row.key !== 'Unknown folder') return row.key; return process.cwd(); }
  launchNewSession(harness, cwdValue) { const adapter = this.adapters.find((item) => item.id === harness); if (!adapter?.newSession) throw new Error(`Harness cannot create sessions: ${harness}`); const cwd = String(cwdValue || '').replace(/^~(?=\/|$)/, process.env.HOME || ''); if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) { this.status = `Working directory does not exist: ${cwd}`; return; } const launch = adapter.newSession; this.pendingAction = null; if (this.openMode === 'tty') return {type: 'open', command: launch.command, args: [...(launch.args || [])], cwd}; const [terminal, ...terminalArgs] = (process.env.TERMINAL || 'xdg-terminal-exec').split(/\s+/); const child = spawn(terminal, [...terminalArgs, launch.command, ...(launch.args || [])], {cwd, detached: true, stdio: 'ignore'}); child.unref(); this.status = `Started a new ${adapter.name} session in ${cwd}`; }
  selectedProjectRoot() { const row=this.selectedRow();return row?.session?.cwd||row?.key||''; }
  runLocalSearch() { this.searchMode='local';this.aiResults=[];this.searchResults = this.query ? this.index.search(this.query) : []; this.selectedSession = 0; this.scroll = 0; }
  async askAiToLocate() { if(!this.query){this.status='Enter a local search query first';return;}const preferred=this.store.getKv('ai_provider')||undefined,preview=this.rag.preview(this.query,{provider:preferred});this.status=`Asking ${preview.provider} to rank ${preview.candidateCount} redacted candidates…`;this.onStatus?.();const result=await this.rag.find(this.query,{provider:preview.provider});this.aiProvider=result.provider;this.aiResults=result.matches;this.searchMode='ai';this.selectedSession=0;this.scroll=0;this.status=result.matches.length?`${result.provider} found ${result.matches.length} evidence-backed matches`:(result.message||`${result.provider} found no supported match`); }
  async toggleAiSearch() { if(this.searchMode==='ai'){this.searchMode='local';this.selectedSession=0;this.scroll=0;this.status='Showing local search results';return;}return this.askAiToLocate(); }
  openSessionFinder(prompt=true,mode='local') { if(this.view!=='search'){this.finderReturnView=this.view;this.finderReturnQuery=this.query;}this.view='search';this.query='';this.runLocalSearch();this.finderPromptMode=mode;if(prompt){this.prompt=true;this.promptKind='search';this.promptValue='';}this.status=mode==='ai'?'Describe the session for AI retrieval':'Search all session content'; }
  closeSessionFinder() { this.view=this.finderReturnView||'dashboard';this.query=this.finderReturnQuery||'';this.searchResults=[];this.aiResults=[];this.searchMode='local';this.selectedSession=Number(this.store.state.ui?.selections?.[this.view]||0);this.scroll=0;this.recompute();this.status=`Returned to ${this.view}`; }
  async openGlobalSessionFinder(mode='ai') { if(this.view!=='search')return this.openSessionFinder(true,mode);if(!this.query){this.prompt=true;this.promptKind='search';this.promptValue='';this.finderPromptMode=mode;return;}return this.toggleAiSearch(); }
  relatedSelected() { const session=this.selected();if(!session)return[];const key=`${sessionKey(session)}:${session.updatedAt||0}`;if(!this.relatedCache.has(key))this.relatedCache.set(key,this.index.related(session));return this.relatedCache.get(key); }
  refreshProjectSummaries(deepLimit=8) { this.projectSummaries.clear();const grouped=new Map();for(const session of this.sessions){if(!session.cwd)continue;const rows=grouped.get(session.cwd)||[];rows.push(session);grouped.set(session.cwd,rows);}let profileCounts=new Map();try{for(const profile of this.profiles.list())profileCounts.set(profile.projectKey,(profileCounts.get(profile.projectKey)||0)+1);}catch{}let inspected=0;for(const [cwd,sessions] of grouped){let worktrees=[];if(inspected<deepLimit){try{worktrees=this.worktrees.inspect(cwd);inspected++;}catch{}}this.projectSummaries.set(cwd,{active:sessions.filter((session)=>[STATUS.RUNNING,STATUS.WAITING].includes(session.status)).length,dirty:worktrees.filter((item)=>item.dirty).length,worktrees:worktrees.length,profiles:profileCounts.get(cwd)||0,branches:new Set(sessions.map((session)=>session.branch).filter(Boolean)).size,lastActivity:Math.max(...sessions.map((session)=>session.updatedAt||0))});} }
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
const ACTIVE_DISCOVERY_WINDOW = 5 * 60 * 1000;
const DISCOVERY_RETRY_INTERVAL = 5 * 1000;
function mergeMetadata(session, local) { const git = session.git || {}; return {...session, title: local.alias || session.title, branch: session.branch || git.branch || '', local: {pinned: false, alias: '', note: '', hidden: false, ...local}, status: STATUS.OFFLINE, statusUpdatedAt: session.updatedAt}; }
function action(id, label, enabled, reason = '') { return {id, label, enabled, reason}; }
function fuzzy(value, query) { let index = 0; for (const character of value) if (character === query[index]) index += 1; return index === query.length; }
function fuzzyScore(value, query) { if (!query) return 0; const exact = value.indexOf(query); return exact >= 0 ? 1000 - exact : query.length; }
function pathName(value) { return String(value || 'project').split('/').filter(Boolean).pop() || 'project'; }
function shortError(error) { return String(error?.stderr || error?.message || error).trim().split('\n').pop().replace(/^Error:\s*/,''); }

export function folderKey(session) {
  return session.cwd || session.project || 'Unknown folder';
}

export function sortByFolderActivity(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const key = folderKey(session);
    const group = groups.get(key) || {key, updatedAt: 0, sessions: []};
    group.updatedAt = Math.max(group.updatedAt, Number(session.updatedAt || 0));
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
    .flatMap((group) => group.sessions.sort((a, b) => b.updatedAt - a.updatedAt));
}
