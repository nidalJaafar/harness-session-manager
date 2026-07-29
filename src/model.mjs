import fs from 'node:fs';
import {loadAll} from './adapters.mjs';
import {applyLiveState, scanHarnessProcesses, STATUS} from './live.mjs';
import {StateStore, sessionKey} from './state.mjs';
import {IntelligenceIndex} from './intelligence.mjs';
import {WorktreeManager} from './projects.mjs';
import {RagLocator} from './rag.mjs';
import {UpdateManager} from './update.mjs';
import {canOpenTerminalWindow, newSessionLaunchMethod} from './launch.mjs';

export class SessionHubModel {
  constructor({adapters = [], environment = process.env, store = new StateStore(), processScanner = scanHarnessProcesses, showSubagents = undefined} = {}) {
    this.adapters = adapters;
    this.store = store;
    this.environment = environment;
    this.processScanner = processScanner;
    this.index = new IntelligenceIndex(store);
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
    this.finderFocus = 'query';
    this.finderText = '';
    this.finderFilters = {project:'',harness:'',branch:''};
    this.finderFilterIndex = 0;
    this.aiProvider = '';
    this.projectSummaries = new Map();
    this.relatedCache = new Map();
    this.events = [];
    this.palette = false;
    this.paletteQuery = '';
    this.paletteIndex = 0;
    this.paletteMessage = '';
    this.help = false;
    this.onboarding = false;
    this.onboardingStep = 0;
    this.launcher = false;
    this.launcherIndex = 0;
    this.promptKind = '';
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
    if (this.onboarding) {
      const expected = ONBOARDING_KEYS[this.onboardingStep];
      if (key === 'esc' && expected !== 'esc') { this.finishOnboarding('Tour ended · restart it from Help or Ctrl+K'); return; }
      if (key !== expected) return;
      if (key === 'enter') { this.advanceOnboarding(key); return; }
    }
    if (this.help) { if (key === 't') { this.help = false; this.startOnboarding(true); } else if (key === '?' || key === 'esc' || key === 'q' || key === 'ctrl+c') this.help = false; return; }
    if (this.launcher) return this.launcherKey(key);
    if (this.palette) { const result=await this.paletteKey(key);if(this.onboarding)this.advanceOnboarding(key);return result; }
    if (this.prompt) return this.promptKey(key);
    if (this.view === 'search') { const result=await this.finderKey(key);if(this.onboarding)this.advanceOnboarding(key);return result; }
    if (key === 'q' || key === 'ctrl+c') return 'quit';
    if (key === '?') this.help = true;
    else if (key === '1') this.setView('dashboard');
    else if (key === '2') this.setView('projects');
    else if (key === 'ctrl+k') this.openPalette();
    else if (key === 'n') this.openLauncher();
    else if (key === 'tab' || key === 'f') this.cycleSource();
    else if (key === 'j' || key === 'down') this.move(1);
    else if (key === 'k' || key === 'up') this.move(-1);
    else if (key === 'pageup') this.move(-10);
    else if (key === 'pagedown') this.move(10);
    else if (key === '/') this.openSessionFinder(false,'local');
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
    else if (key === 'esc' && this.preview.length) { this.preview = []; this.status = 'Preview closed'; }
    if (this.onboarding) this.advanceOnboarding(key);
  }

  async promptKey(key) {
    if (key === 'esc' || key === 'ctrl+c') { this.prompt = false; return; }
    if (key === 'enter') {
      this.prompt = false;
      const value = this.promptValue.trim();
      return this.completePrompt(value);
    }
    if (key === 'backspace') this.promptValue = this.promptValue.slice(0, -1);
    else if (key === 'space') this.promptValue += ' ';
    else if (key.length === 1) this.promptValue += key;
  }

  async finderKey(key) {
    if(key==='ctrl+c')return'quit';
    if(key==='esc'){this.closeSessionFinder();return;}
    if(key==='/'){this.finderFocus='query';return;}
    if(key==='tab'){
      if(this.finderFocus==='query'){this.finderFocus='filters';this.finderFilterIndex=0;}
      else if(this.finderFocus==='filters'&&this.finderFilterIndex<FINDER_FILTERS.length-1)this.finderFilterIndex++;
      else if(this.finderFocus==='filters')this.finderFocus='results';
      else this.finderFocus='query';
      return;
    }
    if(this.finderFocus==='query'){
      if(key==='enter'||key==='down'){this.finderFocus='results';return;}
      if(key==='backspace')this.finderText=this.finderText.slice(0,-1);
      else if(key==='space')this.finderText+=' ';
      else if(key.length===1)this.finderText+=key;
      else return;
      this.updateFinderQuery();return;
    }
    if(this.finderFocus==='filters'){
      const field=FINDER_FILTERS[this.finderFilterIndex];
      if(key==='backspace'){this.finderFilters[field]=this.finderFilters[field].slice(0,-1);this.updateFinderQuery();}
      else if(key==='space'){this.finderFilters[field]+=' ';this.updateFinderQuery();}
      else if(key==='up')this.cycleFinderFilter(-1);
      else if(key==='down')this.cycleFinderFilter(1);
      else if(key==='enter')this.finderFocus='results';
      else if(key.length===1){this.finderFilters[field]+=key;this.updateFinderQuery();}
      return;
    }
    if(key==='A')return this.toggleAiSearch();
    if(key==='ctrl+k'){this.openPalette();return;}
    if(key==='?'){this.help=true;return;}
    if(key==='j'||key==='down')this.move(1);
    else if(key==='k'||key==='up')this.move(-1);
    else if(key==='pageup')this.move(-10);
    else if(key==='pagedown')this.move(10);
    else if(key==='enter'||key==='v')await this.previewSelected();
    else if(key==='o')return this.openSelected();
  }

  finderFilterOptions(field){return['',...this.index.facetValues(field)];}
  cycleFinderFilter(delta){const field=FINDER_FILTERS[this.finderFilterIndex],options=this.finderFilterOptions(field),current=Math.max(0,options.indexOf(this.finderFilters[field])),next=(current+delta+options.length)%options.length;this.finderFilters[field]=options[next];this.updateFinderQuery();}
  updateFinderQuery(){const filters=FINDER_FILTERS.filter((field)=>this.finderFilters[field]).map((field)=>`${field}:${quoteSearchValue(this.finderFilters[field])}`);this.query=[this.finderText.trim(),...filters].filter(Boolean).join(' ');this.store.setUi({finderQuery:this.query});this.preview=[];this.runLocalSearch();this.status=this.query?`Local results: ${this.query}`:'Type to search, or Tab to choose filters';}

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

  openSelected(method = 'current') {
    const session = this.selected();
    if (!session) return;
    return this.launchSession(session, method);
  }

  launchSession(session, method = 'current') {
    const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : process.cwd();
    this.store.updateSession(sessionKey(session), {lastOpenedAt: Date.now()});
    this.store.setUi({latestSession: sessionKey(session)});
    return {type: 'open', method, ...session.resume, cwd, sessionKey: sessionKey(session), label: session.harnessName};
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
    const actions = [
      action('new-session', 'Start a new session', this.launchableAdapters().length > 0),
      action('search-index','Find a session',true),
      action('subagents', this.showSubagents ? 'Hide child-agent sessions' : 'Show child-agent sessions', true),
      action('onboarding', 'Start the guided tour', true),
      ...(this.store.state.ui?.latestSession || this.store.state.ui?.mission ? [action('latest-session', 'Go to last resumed session', true)] : []),
      ...(this.view==='search'&&this.query ? [action('ai-locate',this.searchMode==='ai'?'Show local search results':'Ask AI to rank these results',true)] : []),
      ...(session ? [
        action('resume', 'Resume in this terminal', true),
        ...(canOpenTerminalWindow(this.environment) ? [action('resume-window', 'Resume in a new terminal window', true)] : []),
        action('pin', session.local?.pinned ? 'Unpin session' : 'Pin session', true),
        action(session.local?.snoozedUntil ? 'wake' : 'snooze', session.local?.snoozedUntil ? 'Wake session notifications' : 'Snooze notifications for one hour', true),
        action('alias', 'Set local alias', true), action('tag', 'Set session tag', true), action('note', 'Add local note', true),
        ...(session.capabilities?.rename ? [action('rename', 'Rename session', true)] : []),
        ...(session.capabilities?.archive ? [action('archive', 'Archive session', true)] : []),
        action('hide', 'Hide session from HSM', true),
      ] : []),
    ];
    const query = this.paletteQuery.toLowerCase();
    return actions.filter((item) => fuzzy(item.label.toLowerCase(), query)).sort((a, b) => fuzzyScore(b.label.toLowerCase(), query) - fuzzyScore(a.label.toLowerCase(), query));
  }
  async paletteKey(key) { if (key === 'esc' || key === 'ctrl+c') { this.palette = false; return; } const items = this.paletteItems(); if (key === 'up') { this.paletteIndex = clamp(this.paletteIndex - 1, 0, Math.max(0, items.length - 1)); this.paletteMessage = ''; } else if (key === 'down') { this.paletteIndex = clamp(this.paletteIndex + 1, 0, Math.max(0, items.length - 1)); this.paletteMessage = ''; } else if (key === 'backspace') { this.paletteQuery = this.paletteQuery.slice(0, -1); this.paletteIndex = 0; this.paletteMessage = ''; } else if (key === 'enter') { const item = items[this.paletteIndex]; if (!item?.enabled) { this.paletteMessage = item.reason || 'This action is unavailable for the current selection.'; this.status = this.paletteMessage; } else return this.runPaletteAction(item); } else if (key.length === 1) { this.paletteQuery += key; this.paletteIndex = 0; this.paletteMessage = ''; } }
  async runPaletteAction(item) {
    this.palette = false;
    if (item.id === 'new-session') return this.openLauncher();
    if (item.id === 'search-index') { this.openSessionFinder(); return; }
    if (item.id === 'ai-locate') return this.toggleAiSearch();
    if (item.id === 'onboarding') return this.startOnboarding(true);
    if (item.id === 'latest-session') return this.returnToLatestSession();
    if (item.id === 'snooze') return this.snoozeSelected(60 * 60 * 1000);
    if (item.id === 'wake') return this.wakeSelected();
    if (item.id === 'subagents') return this.toggleSubagents();
    if (item.id === 'resume') return this.openSelected();
    if (item.id === 'resume-window') return this.openSelected('window');
    if (item.id === 'pin') return this.togglePin();
    if (['alias', 'tag', 'note', 'rename', 'move'].includes(item.id)) {
      this.prompt = true; this.promptKind = item.id;
      this.promptValue = item.id === 'alias' ? this.selected().local.alias || '' : item.id === 'tag' ? this.selected().tag || this.selected().local.tag || '' : item.id === 'note' ? this.selected().local.note || '' : item.id === 'rename' ? this.selected().title : '';
      return;
    }
    if (['archive', 'hide'].includes(item.id)) { this.prompt = true; this.promptKind = 'confirm'; this.promptValue = ''; this.pendingAction = item.id; this.status = `Type yes to ${item.id} ${this.selected().title}`; return; }
  }
  async completePrompt(value) {
    if (this.promptKind === 'new-session') return this.launchNewSession(this.pendingAction, value);
    const session = this.selected(); if (!session) return;
    const adapter = this.adapters.find((item) => item.id === session.harness);
    if (this.promptKind === 'alias' || this.promptKind === 'note') { this.store.updateSession(sessionKey(session), {[this.promptKind]: value}); session.local[this.promptKind] = value; this.recordAction(session, `${this.promptKind}-updated`); this.status = `Saved local ${this.promptKind}`; return; }
    if (this.promptKind === 'tag') { if (session.capabilities?.tag && adapter.tag) { await adapter.tag(session, value); session.tag = value; } else { this.store.updateSession(sessionKey(session), {tag: value}); session.local.tag = value; } this.recordAction(session, 'tagged', value); this.status = `Tagged ${session.title} as ${value}`; return; }
    if (this.promptKind === 'rename') { await adapter.rename(session, value); this.store.recordUndo({type: 'rename', session: sessionKey(session), before: session.title, after: value}); this.recordAction(session, 'renamed', value); session.title = value; this.status = `Renamed to ${value}`; return; }
    if (this.promptKind === 'confirm') { if (value !== 'yes') { this.status = 'Action cancelled'; return; } await this.destructiveAction(this.pendingAction, session); }
  }
  async destructiveAction(kind, session) {
    if (kind === 'hide') { this.store.updateSession(sessionKey(session), {hidden: true}); this.store.recordUndo({type: 'hide', session: sessionKey(session)}); this.recordAction(session, 'hidden'); this.status = `Hidden ${session.title}`; return this.load(); }
    const adapter = this.adapters.find((item) => item.id === session.harness);
    if (kind === 'archive') { const result = await adapter.archive(session); this.store.recordUndo({type: 'archive', session: sessionKey(session), backupPath: result.backupPath, nativeSource: session.nativeSource}); this.recordAction(session, 'archived'); this.status = `Archived ${session.title}`; return this.load(); }
  }
  async undoLatest() {
    const undo = this.store.latestUndo(); if (!undo) { this.status = 'Nothing to undo'; return; }
    const [harness, id] = undo.session.split(':');
    let session = this.sessions.find((item) => item.harness === harness && item.id === id) || {harness, id, nativeSource: undo.nativeSource};
    if (undo.type === 'archive' && undo.nativeSource) session = {...session, nativeSource: undo.nativeSource};
    const adapter = this.adapters.find((item) => item.id === harness);
    if (undo.type === 'archive' && adapter?.restore) await adapter.restore(session);
    else if (undo.type === 'rename' && adapter?.rename) await adapter.rename(session, undo.before);
    else if (undo.type === 'move' && adapter?.move) await adapter.move(session, undo.before);
    else if (undo.type === 'hide') this.store.updateSession(undo.session, {hidden: false});
    else { this.status = 'Latest action cannot be undone in the current session'; return; }
    this.status = `Undid ${undo.type}`; await this.load();
  }
  recordAction(session, type, message = '') { const event = this.store.appendEvent({harness: session.harness, sessionId: session.id, type, timestamp: Date.now(), cwd: session.cwd, message}); this.events.unshift(event); }
  launchableAdapters() { return this.adapters.filter((adapter) => adapter.available() && adapter.newSession?.command); }
  openLauncher() { this.palette = false; this.launcher = true; this.launcherIndex = 0; this.status = 'Choose a harness for the new session'; }
  launcherKey(key) { const adapters = this.launchableAdapters(); if (key === 'esc' || key === 'ctrl+c') { this.launcher = false; return; } if (key === 'up' || key === 'k') this.launcherIndex = clamp(this.launcherIndex - 1, 0, Math.max(0, adapters.length - 1)); else if (key === 'down' || key === 'j') this.launcherIndex = clamp(this.launcherIndex + 1, 0, Math.max(0, adapters.length - 1)); else if (key === 'enter') { const adapter = adapters[this.launcherIndex]; if (!adapter) return; this.launcher = false; this.prompt = true; this.promptKind = 'new-session'; this.pendingAction = adapter.id; this.promptValue = this.defaultLaunchCwd(); } }
  defaultLaunchCwd() { const row = this.selectedRow(); if (row?.session?.cwd) return row.session.cwd; if (row?.type === 'folder' && row.key !== 'Unknown folder') return row.key; return process.cwd(); }
  launchNewSession(harness, cwdValue) { const adapter = this.adapters.find((item) => item.id === harness); if (!adapter?.newSession) throw new Error(`Harness cannot create sessions: ${harness}`); const cwd = String(cwdValue || '').replace(/^~(?=\/|$)/, this.environment.HOME || ''); if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) { this.status = `Working directory does not exist: ${cwd}`; return; } const launch = adapter.newSession; this.pendingAction = null; return {type:'open',method:newSessionLaunchMethod(this.environment),command:launch.command,args:[...(launch.args||[])],...(launch.env?{env:launch.env}:{}),cwd,label:adapter.name}; }
  runLocalSearch() { this.searchMode='local';this.aiResults=[];this.searchResults = this.query ? this.index.search(this.query) : []; this.selectedSession = 0; this.scroll = 0; }
  async askAiToLocate() { if(!this.query){this.status='Enter a local search query first';return;}const preferred=this.store.getKv('ai_provider')||undefined,preview=this.rag.preview(this.query,{provider:preferred});this.status=`Asking ${preview.provider} to rank ${preview.candidateCount} redacted candidates…`;this.onStatus?.();const result=await this.rag.find(this.query,{provider:preview.provider});this.aiProvider=result.provider;this.aiResults=result.matches;this.searchMode='ai';this.selectedSession=0;this.scroll=0;this.status=result.matches.length?`${result.provider} found ${result.matches.length} evidence-backed matches`:(result.message||`${result.provider} found no supported match`); }
  async toggleAiSearch() { if(this.searchMode==='ai'){this.searchMode='local';this.selectedSession=0;this.scroll=0;this.status='Showing local search results';return;}return this.askAiToLocate(); }
  openSessionFinder(_prompt=true,_mode='local') { if(this.view!=='search'){this.finderReturnView=this.view;this.finderReturnQuery=this.query;}this.view='search';this.query='';this.finderText='';this.finderFilters={project:'',harness:'',branch:''};this.finderFilterIndex=0;this.finderFocus='query';this.runLocalSearch();this.status='Type to search · Tab selects filters'; }
  closeSessionFinder() { this.view=this.finderReturnView||'dashboard';this.query=this.finderReturnQuery||'';this.searchResults=[];this.aiResults=[];this.searchMode='local';this.selectedSession=Number(this.store.state.ui?.selections?.[this.view]||0);this.scroll=0;this.recompute();this.status=`Returned to ${this.view}`; }
  async openGlobalSessionFinder(mode='ai') { if(this.view!=='search')return this.openSessionFinder(false,mode);if(!this.query){this.finderFocus='query';this.status='Type a search before asking AI';return;}return this.toggleAiSearch(); }
  relatedSelected() { const session=this.selected();if(!session)return[];const key=`${sessionKey(session)}:${session.updatedAt||0}`;if(!this.relatedCache.has(key))this.relatedCache.set(key,this.index.related(session));return this.relatedCache.get(key); }
  refreshProjectSummaries(deepLimit=8) { this.projectSummaries.clear();const grouped=new Map();for(const session of this.sessions){if(!session.cwd)continue;const rows=grouped.get(session.cwd)||[];rows.push(session);grouped.set(session.cwd,rows);}let inspected=0;for(const [cwd,sessions] of grouped){let worktrees=[];if(inspected<deepLimit){try{worktrees=this.worktrees.inspect(cwd);inspected++;}catch{}}this.projectSummaries.set(cwd,{active:sessions.filter((session)=>[STATUS.RUNNING,STATUS.WAITING].includes(session.status)).length,dirty:worktrees.filter((item)=>item.dirty).length,worktrees:worktrees.length,branches:new Set(sessions.map((session)=>session.branch).filter(Boolean)).size,lastActivity:Math.max(...sessions.map((session)=>session.updatedAt||0))});} }
  startOnboardingIfNeeded() { if(Number(this.store.state.ui?.onboardingVersion||0)<ONBOARDING_VERSION)this.startOnboarding(); }
  startOnboarding() { this.palette=false;this.help=false;this.prompt=false;this.onboarding=true;this.onboardingStep=0;this.setView('dashboard'); }
  advanceOnboarding(key) { if(key!==ONBOARDING_KEYS[this.onboardingStep])return;this.onboardingStep++;if(this.onboardingStep>=ONBOARDING_KEYS.length)this.finishOnboarding('Tour complete · press ? whenever you need the keyboard reference'); }
  finishOnboarding(status) { this.onboarding=false;this.store.setUi({onboardingVersion:ONBOARDING_VERSION});this.status=status; }
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
const ACTIVE_DISCOVERY_WINDOW = 5 * 60 * 1000;
const DISCOVERY_RETRY_INTERVAL = 5 * 1000;
const FINDER_FILTERS = ['project','harness','branch'];
export const ONBOARDING_VERSION = 3;
export const ONBOARDING_KEYS = ['enter','2','1','/','esc','ctrl+k','esc','enter','enter','enter'];
function mergeMetadata(session, local) { const git = session.git || {}; return {...session, title: local.alias || session.title, branch: session.branch || git.branch || '', local: {pinned: false, alias: '', note: '', hidden: false, ...local}, status: STATUS.OFFLINE, statusUpdatedAt: session.updatedAt}; }
function action(id, label, enabled, reason = '') { return {id, label, enabled, reason}; }
function fuzzy(value, query) { let index = 0; for (const character of value) if (character === query[index]) index += 1; return index === query.length; }
function fuzzyScore(value, query) { if (!query) return 0; const exact = value.indexOf(query); return exact >= 0 ? 1000 - exact : query.length; }
function shortError(error) { return String(error?.stderr || error?.message || error).trim().split('\n').pop().replace(/^Error:\s*/,''); }
function quoteSearchValue(value){const text=String(value);return /\s/.test(text)?`"${text.replaceAll('"','\\"')}"`:text;}

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
