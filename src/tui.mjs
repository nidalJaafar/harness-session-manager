import {spawn, spawnSync} from 'node:child_process';
import {parseQuery} from './intelligence.mjs';

export function render(model) {
  const screen = renderScreen(model);
  return model.onboarding ? renderTourOverlay(screen, model) : screen;
}

function renderScreen(model) {
  if (model.help) return renderHelp(model);
  if (model.launcher) return renderLauncher(model);
  if (model.palette) return renderPalette(model);
  if (model.prompt) return box(promptLines(model), Math.min(78, model.width), ' input ', true).join('\n');
  const width = Math.max(76, model.width);
  const height = Math.max(22, model.height);
  const mainWidth = Math.max(48, Math.floor(width * 0.64));
  const detailWidth = width - mainWidth - 1;
  const bodyHeight = height - 8;
  const left = model.view === 'dashboard' ? dashboardLines(model, mainWidth - 2, bodyHeight - 2) : model.view === 'search' ? searchLines(model, mainWidth - 2, bodyHeight - 2) : sessionLines(model, mainWidth - 2, bodyHeight - 2);
  const right = detailLines(model, detailWidth - 2, bodyHeight - 2);
  const viewTitle = model.view === 'dashboard' ? ' attention dashboard ' : model.view === 'search' ? ' session finder ' : ' project cockpits ';
  const body = columns(box(left, mainWidth, viewTitle, true, bodyHeight), box(right, detailWidth, ' context ', false, bodyHeight));
  const selected = model.selected();
  const source = model.sources[model.selectedSource];
  const headerLeft = model.view==='search'?'HSM  / SESSION FINDER':`HSM  1 Dashboard  2 Projects  / ${model.view.toUpperCase()}`;
  const hiddenSubagents = model.sessions.filter((session) => session.isSubagent && (model.source === 'all' || session.harness === model.source)).length;
  const headerRight = `${source?.name || 'All harnesses'}  Folders:${folderCount(model)}  Sessions:${model.filtered.length}/${model.sessions.length}${hiddenSubagents ? `  Agents:${model.showSubagents ? 'shown' : `hidden ${hiddenSubagents}`}` : ''}`;
  return [fit(headerLeft + ' '.repeat(Math.max(1, width - headerLeft.length - headerRight.length)) + headerRight, width), '─'.repeat(width), ...body,
    fit(` ${contextLine(model)}`, width),
    fit(` ${model.updateInfo?.available?`↑ HSM ${model.updateInfo.latestVersion} is available · run hsm update`:model.status}`, width),
    fit(`${model.view==='search'?` Esc back   / query   Tab next field${model.finderFocus==='results'?`   A ${model.searchMode==='ai'?'local':'ask AI'}`:''}`:' 1/2 views   j/k move   n new   o resume in this terminal   / find'}   Ctrl+K actions   ? help`, width)].join('\n');
}

function renderHelp(model) {
  const width = Math.min(96, Math.max(70, model.width - 10));
  const lines = [
    '  NAVIGATION',
    '  1 Dashboard    2 Projects',
    '  j/k or ↑/↓ Move    PgUp/PgDn Jump ten rows',
    '',
    '  SESSION & FOLDERS',
    '  Enter Expand/inspect    ←/→ Collapse/expand',
    '  n New session    v Preview',
    '  o Resume in this terminal',
    '  h Show resume command',
    '  p Pin/unpin    z Snooze 1h    w Wake now',
    '  l Go to latest session    u Undo',
    '',
    '  FILTERS & ACTIONS',
    '  / Search    f/Tab Harness    s Subagents',
    '  / Open session finder with local search',
    '  Finder: Tab through Search, Project, Harness, Branch, and Results',
    '  Type directly in every search and filter field',
    '  In Finder only: A toggle AI/local ranking',
    '  g Grouped/recent    r Reload    Ctrl+K Actions',
    '  Project stats: active · branches · worktrees',
    '',
    '  GENERAL',
    '  t Start guided tour    ? Help',
    '  Esc Close overlay    q/Ctrl+C Quit',
    '',
    '  Press ?, Esc, or q to close',
  ];
  return box(lines, width, ' keyboard reference ', true).join('\n');
}

const TOUR_STEPS = [
  {
    title: 'Welcome to HSM',
    body: ['This walkthrough uses the real application. Each card waits for the key it teaches, then the interface changes underneath it.'],
    instruction: 'Press Enter to begin',
  },
  {
    title: 'The attention dashboard',
    body: ['This is the default view. ◆ needs input, ● is running, ★ is pinned, ◌ is snoozed, and recent sessions stay within reach.', 'Dashboard lanes let you see what needs attention before browsing by project.'],
    instruction: 'Press 2 to open Projects',
  },
  {
    title: 'Projects and working folders',
    body: ['Projects groups sessions by working folder. Each row summarizes active sessions, branches, worktrees, dirty state, and the harnesses used there.', 'Use j/k to move, Enter to expand, and v to preview the selected session.'],
    instruction: 'Press 1 to return to Dashboard',
  },
  {
    title: 'Finding an old session',
    body: ['HSM indexes transcript text locally, so you can find work by what was discussed instead of remembering a session ID.', 'Finder is available from Dashboard and Projects.'],
    instruction: 'Press / to open Session Finder',
  },
  {
    title: 'Session Finder',
    body: ['Type directly into Search while results remain visible. Each press of Tab moves into Project, Harness, Branch, and then the results; type a filter value directly in its field.', 'AI ranking runs only when you explicitly press A from the results; ordinary search stays on this machine.'],
    instruction: 'Press Esc to return to Dashboard',
  },
  {
    title: 'Actions follow your selection',
    body: ['Ctrl+K shows global commands plus actions that can actually run on the selected row. Unsupported harness operations and unusable desktop actions are left out.'],
    instruction: 'Press Ctrl+K to open Actions',
  },
  {
    title: 'The contextual action palette',
    body: ['Type to filter this list and use the arrow keys to choose an action. Select a session before opening the palette to see resume, pin, snooze, metadata, and supported native actions.'],
    instruction: 'Press Esc to close Actions',
  },
  {
    title: 'Resuming sessions',
    body: ['Press o on a session to run it in this terminal. HSM steps aside, gives the harness normal terminal input, then returns and refreshes when the harness exits.', 'On a local desktop, Ctrl+K can also offer “Resume in a new terminal window.” That action is hidden over SSH.'],
    instruction: 'Press Enter to continue',
  },
  {
    title: 'Starting and organizing work',
    body: ['Press n to choose a harness and working directory for a new session.', 'Use p to pin, z to snooze notifications, w to wake them, s to show child-agent sessions, and u to undo supported management actions.'],
    instruction: 'Press Enter to continue',
  },
  {
    title: 'You are ready',
    body: ['The bottom line always shows the most useful shortcuts for the current view. Press ? for the full keyboard reference or restart this tour from Help or Ctrl+K.'],
    instruction: 'Press Enter to close the tour',
  },
];

function renderTourOverlay(background, model) {
  const width=Math.max(76,model.width),height=Math.max(22,model.height),step=TOUR_STEPS[model.onboardingStep]||TOUR_STEPS[0];
  const popupWidth=Math.min(76,width-8),bodyWidth=popupWidth-8;
  const lines=[`  ${step.title.toUpperCase()}`,''];
  for(const paragraph of step.body){lines.push(...wrapText(paragraph,bodyWidth,6).map((line)=>`  ${line}`), '');}
  lines.push(`  → ${step.instruction}`,'',`  Step ${model.onboardingStep+1} of ${TOUR_STEPS.length}${step.instruction.includes('Esc')?'':' · Esc skips the tour'}`);
  const popup=box(lines,popupWidth,` guided tour · ${model.onboardingStep+1}/${TOUR_STEPS.length} `,true);
  const canvas=Array.from({length:height},(_,index)=>fit(background.split('\n')[index]||'',width).padEnd(width));
  const top=Math.max(0,Math.floor((height-popup.length)/2)),left=Math.max(0,Math.floor((width-popupWidth)/2));
  for(let index=0;index<popup.length&&top+index<height;index++){const row=canvas[top+index];canvas[top+index]=`${row.slice(0,left)}${popup[index]}${row.slice(left+popup[index].length)}`.slice(0,width).padEnd(width);}
  return canvas.join('\n');
}

function renderLauncher(model) {
  const width = Math.min(76, Math.max(56, model.width - 18));
  const adapters = model.launchableAdapters();
  const lines = ['  Choose the coding harness to start.', '  The next step lets you edit the working directory.', ''];
  for (const [index, adapter] of adapters.entries()) {
    const launch = adapter.newSession;
    lines.push(fit(`${index === model.launcherIndex ? '❯' : ' '} ${badge(adapter.id)} ${adapter.name}   ${launch.command} ${(launch.args || []).join(' ')}`, width - 2));
  }
  if (!adapters.length) lines.push('  No installed harness supports creating a new session.');
  lines.push('', '  ↑/↓ or j/k move · Enter continue · Esc cancel');
  return box(lines, width, ' new session ', true).join('\n');
}

function dashboardLines(model, width, height) {
  const rows = model.rows();
  const lines = ['  LIVE ATTENTION QUEUE', ''];
  const end = visibleRowEnd(rows, model.scroll, height - 3);
  for (let i = model.scroll; i < end; i += 1) {
    const row = rows[i];
    const active = i === model.selectedSession;
    if (row.type === 'lane') {
      const collapsed = model.collapsedFolders.has(`lane:${row.lane}`);
      lines.push(fit(`${active ? '❯' : ' '} ${collapsed ? '▶' : '▼'} ${laneGlyph(row.lane)} ${row.lane.toUpperCase()}  ${row.count}`, width));
      continue;
    }
    lines.push(commandCenterSessionLine(row.session, active, width, '    '));
  }
  while (lines.length < height) lines.push('');
  return lines.slice(0, height);
}

function sessionLines(model, width, height) {
  const lines = [];
  const selected = model.selected();
  const rows = model.queueRows();
  const previewSpace = model.preview.length ? Math.min(6, model.preview.length + 2) : 0;
  const end = visibleRowEnd(rows, model.scroll, Math.max(1, height - 4 - previewSpace));
  const label = model.viewMode === 'folders' ? 'FOLDERS · NEWEST ACTIVITY FIRST' : 'RECENT ACTIVITY';
  lines.push(`  ${model.query ? `FILTER / ${model.query.toUpperCase()}` : label}                              ${rows.length ? model.scroll + 1 : 0}-${end}/${rows.length}`, '');
  for (let i = model.scroll; i < end; i += 1) {
    const row = rows[i];
    const active = model.focus === 'sessions' && i === model.selectedSession;
    if (row.type === 'folder') {
      const claude = row.sessions.filter((session) => session.harness === 'claude').length;
      const opencode = row.sessions.filter((session) => session.harness === 'opencode').length;
      const codex = row.sessions.filter((session) => session.harness === 'codex').length;
      const pi = row.sessions.filter((session) => session.harness === 'pi').length;
      const signals = [claude ? `${claude} CC` : '', opencode ? `${opencode} OC` : '',codex?`${codex} CX`:'',pi?`${pi} PI`:''].filter(Boolean).join(' · ');
      const folder = folderParts(row.key);
      const summary = row.summary || {};
      lines.push(fit(`${active ? '❯' : ' '} ${row.collapsed ? '▶' : '▼'} ${folder.name}  (${row.sessions.length})  ${signals}  ${summary.active || 0} active · ${summary.branches || 0} branches · ${summary.worktrees || 0} worktrees`, width));
      lines.push(fit(`      ${folder.parent}`, width));
      continue;
    }
    const session = row.session;
    const branch = row.isLast ? '└──' : '├──';
    lines.push(sessionTreeLine({active, branch, session, width}));
  }
  while (lines.length < height - previewSpace) lines.push('');
  if (model.preview.length) {
    lines.push('  ── TRANSCRIPT SIGNAL ─────────────────────────');
    for (const message of model.preview.slice(-4)) lines.push(fit(`  ${message.role === 'assistant' ? 'A' : message.role === 'user' ? 'U' : '·'}  ${oneLine(message.text)}`, width));
  } else if (selected) {
    lines[lines.length - 1] = fit(`  Open signal: ${selected.resume.command} ${selected.resume.args.join(' ')}`, width);
  } else if (model.selectedRow()?.type === 'folder') {
    const row = model.selectedRow();
    lines[lines.length - 1] = row?.collapsed ? '  ▶  Enter or → to show sessions' : '  ▼  Enter or ← to hide sessions';
  }
  return lines;
}

function searchLines(model, width, height) {
  const mode=model.searchMode==='ai'?`AI RANKING · ${model.aiProvider.toUpperCase()}`:'LOCAL INDEX';
  const lines=[`  ${mode}`];
  if(model.searchMode==='local'){
    const {terms,facets}=parseQuery(model.query),filterFields=['project','harness','branch'];
    lines.push(`${model.finderFocus==='query'?'❯':' '} Search  ${terms}${model.finderFocus==='query'?'▌':''}`);
    for(let offset=0;offset<filterFields.length;offset+=2)lines.push(`  ${filterFields.slice(offset,offset+2).map((field,index)=>{const selected=model.finderFocus==='filters'&&model.finderFilterIndex===offset+index,value=facets[field]||'any';return `${selected?'❯':' '}[${field}: ${value}${selected?'▌':''}]`;}).join('  ')}`);
    if(model.finderFocus==='filters')lines.push('  Type a value · Backspace edits · ↑/↓ suggestions · Tab next');
    else if(model.finderFocus==='query')lines.push('  Type to search · Tab moves through each filter');
    else lines.push('  j/k select result · / edit query · Tab returns to query');
  }else lines.push(`  Request: ${model.query}`);
  lines.push('');
  const rows=model.rows(); const end=Math.min(rows.length,model.scroll+Math.max(1,height-lines.length-1));
  for(let i=model.scroll;i<end;i++){const row=rows[i],active=i===model.selectedSession,result=row.result;if(row.type==='ai-search')lines.push(fit(`${active?'❯':' '} ${badge(result.harness)} ${result.confidence}%  ${result.title}  ${oneLine(result.reason)}`,width));else lines.push(fit(`${active?'❯':' '} ${badge(result.harness)} ${roleBadge(result.role)} ${result.project || 'unknown'} · ${oneLine(result.snippet)}`,width));}
  if(model.query&&!rows.length)lines.push(model.searchMode==='ai'?'  AI found no evidence-backed session.':'  No local match. Focus results, then press A to ask AI.');
  else if(model.searchMode==='local'&&model.query)lines.push('', '  Not right? Focus results, then press A for AI retrieval.');
  while(lines.length<height)lines.push('');return lines.slice(0,height);
}

function promptLines(model){
  const lines=[promptTitle(model),'',`  › ${model.promptValue}`];
  lines.push('',model.promptKind==='confirm'?'  Type yes and press Enter · Esc cancels':'  Enter apply · Esc cancel');
  return lines;
}

function detailLines(model, width, height) {
  const row = model.selectedRow();
  const lines = [];
  if (!row) return ['', '  No sessions match the current filter.'];
  if (row.type === 'ai-search') return ['', `  ${badge(row.result.harness)} AI SESSION MATCH`, '', `  CONFIDENCE  ${row.result.confidence}%`, '', '  TITLE', `  ${row.result.title}`, '', '  WHY IT MATCHED', ...wrapText(row.result.reason || 'No explanation', width - 4, 4).map((line)=>`  ${line}`), '', '  EVIDENCE', ...wrapText(row.result.matchedEvidence || 'No excerpt', width - 4, 5).map((line)=>`  ${line}`), '', row.session ? '  o  Resume exact session' : '  Source session is unavailable'];
  if (row.type === 'search') return ['', `  ${badge(row.result.harness)} SEARCH RESULT · ${roleBadge(row.result.role)}`, '', `  ${row.result.project || 'Unknown project'}`, `  ${row.result.branch || 'No branch'}`, '', `  ${oneLine(row.result.snippet)}`, '', `  ${row.result.paths ? `PATHS  ${row.result.paths}` : ''}`, '', row.session ? '  o  Resume session' : '  Source session is unavailable'];
  if (row.type === 'lane') return ['', `  ${laneGlyph(row.lane)} ${row.lane.toUpperCase()}`, '', `  ${row.count} sessions`, '', '  Enter toggles this lane.'];
  if (row.type === 'folder') {
    const folder = folderParts(row.key);
    const claude = row.sessions.filter((session) => session.harness === 'claude').length;
    const opencode = row.sessions.filter((session) => session.harness === 'opencode').length;
    const codex = row.sessions.filter((session) => session.harness === 'codex').length;
    const pi = row.sessions.filter((session) => session.harness === 'pi').length;
    const summary = row.summary || {};
    const mix=[[claude,'Claude Code'],[opencode,'OpenCode'],[codex,'Codex'],[pi,'Pi']].filter(([count])=>count).map(([count,name])=>`  ${count} ${name}`);
    lines.push('', `  ${row.collapsed ? '▶' : '▼'} ${folder.name}`, '', '  PATH', `  ${folder.parent}`, '', '  COCKPIT', `  ${row.sessions.length} sessions · ${summary.active || 0} active`, `  ${summary.branches || 0} branches · ${summary.worktrees || 0} worktrees`, `  ${summary.dirty || 0} dirty`, '', '  HARNESS MIX', ...mix, '', `  Enter  ${row.collapsed ? 'expand' : 'collapse'}`, `  ${row.collapsed ? '→' : '←'}      ${row.collapsed ? 'expand' : 'collapse'}`);
    return lines.map((line) => fit(line, width));
  }
  const session = row.session;
  if (model.preview.length) {
    lines.push('', `  ${statusGlyph(session)} ${badge(session.harness)} ${session.harnessName}`, '', '  TITLE', `  ${session.local.alias || session.title}`, '', '  YOU LAST ASKED');
    lines.push(...wrapText(session.lastRequest || 'Not available', width - 4, 5).map((line) => `  ${line}`));
    lines.push('', `  ${session.harnessName.toUpperCase()} LAST REPLIED`);
    lines.push(...wrapText(session.lastResponse || 'Not available', width - 4, 7).map((line) => `  ${line}`));
    lines.push('', '  RESUME', `  ${session.resume.command} ${session.resume.args.join(' ')}`, '', '  r reload metadata · Esc returns to browsing');
  } else {
    lines.push('', `  ${statusGlyph(session)} ${badge(session.harness)} ${session.harnessName}`, '', '  TITLE', `  ${session.local.alias || session.title}`, '', '  FOLDER', `  ${session.cwd || 'Unknown'}`, '', '  MODEL / AGENT', `  ${session.model || 'unknown'}${session.agent ? ` · ${session.agent}` : ''}`, '', '  COST / TOKENS', `  ${session.cost == null ? 'not reported' : `$${session.cost.toFixed(4)}`} · ${tokenTotal(session)} tokens`, '', '  GIT', `  ${session.branch || 'no branch'}${session.git?.dirty ? ` · ${session.git.files} dirty files` : ' · clean'}${diffSummary(session)}`, '', '  RESUME', `  ${session.resume.command} ${session.resume.args.join(' ')}`);
    const related = model.relatedSelected();
    if (related.length) lines.push('', '  RELATED', ...related.slice(0, 2).map((item) => `  ${badge(item.harness)} ${item.title}`));
    lines.push('', '  Enter  load preview', '  o      resume session');
  }
  while (lines.length < height) lines.push('');
  return lines.slice(0, height).map((line) => fit(line, width));
}

export async function run(model) {
  const {BoxRenderable, TextRenderable, createCliRenderer, RGBA, StyledText, createTextAttributes} = await import('@opentui/core');
  const colors = {
    fg: RGBA.defaultForeground(),
    bg: RGBA.defaultBackground(),
    cyan: RGBA.fromIndex(6),
    blue: RGBA.fromIndex(12),
    amber: RGBA.fromIndex(3),
    green: RGBA.fromIndex(2),
    magenta: RGBA.fromIndex(5),
    muted: RGBA.fromIndex(8),
    red: RGBA.fromIndex(1),
    bold: createTextAttributes({bold: true}),
    dim: createTextAttributes({dim: true}),
  };
  await model.load();
  model.startOnboardingIfNeeded();
  const renderer = await createCliRenderer({screenMode: 'alternate-screen', exitOnCtrlC: false, clearOnShutdown: true, backgroundColor: colors.bg});
  const root = new BoxRenderable(renderer, {width: '100%', height: '100%', backgroundColor: colors.bg});
  const screen = new TextRenderable(renderer, {content: '', width: '100%', height: '100%', fg: colors.fg, bg: colors.bg});
  root.add(screen); renderer.root.add(root);
  const redraw = () => { model.width = renderer.width || 120; model.height = renderer.height || 36; screen.content = styled(render(model), StyledText, colors); renderer.requestRender(); };
  model.onStatus = redraw;
  void model.checkForUpdates().catch(()=>{});
  renderer.keyInput.on('keypress', (event) => void (async () => { try { const result = await model.key(normalize(event)); if (result === 'quit') return renderer.destroy(); if (result?.type === 'open') await executeLaunch(result,{model,renderer,redraw}); } catch (error) { model.status = `Action failed: ${cleanError(error)}`; } redraw(); })());
  let refreshPending = false;
  const liveTimer = setInterval(() => { if (refreshPending) return; refreshPending = true; void model.refreshLive().catch((error) => { model.status = `Refresh delayed: ${cleanError(error)}`; }).then(redraw).finally(() => { refreshPending = false; }); }, 2000);
  renderer.on('destroy', () => clearInterval(liveTimer));
  renderer.on('resize', redraw); redraw(); renderer.start();
}

export async function executeLaunch(request,{model,renderer,redraw=()=>{},spawnSyncFn=spawnSync,spawnFn=spawn,environment=process.env}={}) {
  if(request.method==='window'){
    const [terminal,...terminalArgs]=String(environment.TERMINAL||'xdg-terminal-exec').split(/\s+/);
    const child=spawnFn(terminal,[...terminalArgs,request.command,...(request.args||[])],{cwd:request.cwd,env:{...environment,...request.env},detached:true,stdio:'ignore'});
    child.once?.('error',(error)=>{model.status=`Could not open new terminal: ${cleanError(error)}`;redraw();});
    child.unref?.();
    model.status=`Launched ${request.label||request.command} in a new terminal`;
    return {method:'window',pid:child.pid};
  }
  const selectedKey=request.sessionKey||'';
  let result;
  renderer.suspend();
  try { result=spawnSyncFn(request.command,request.args||[],{cwd:request.cwd,env:{...environment,...request.env},stdio:'inherit'}); }
  finally { renderer.resume(); }
  await model.load();
  if(selectedKey){const index=model.rows().findIndex((row)=>row.session&&`${row.session.harness}:${row.session.id}`===selectedKey);if(index>=0)model.selectedSession=index;}
  if(result?.error)model.status=`Launch failed: ${cleanError(result.error)}`;
  else if(result?.status&&result.status!==0)model.status=`${request.label||request.command} exited with status ${result.status}`;
  else model.status=`Returned from ${request.label||request.command}`;
  redraw();
  return {method:'current',status:result?.status??null,error:result?.error};
}

function styled(text, StyledText, c) {
  const chunks = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    appendStyledLine(chunks, lines[index], index, lines.length, c);
    if (index < lines.length - 1) chunks.push(textChunk('\n'));
  }
  return new StyledText(chunks);
}

function appendStyledLine(chunks, line, index, lineCount, c) {
  if (/^\s*(hsm:|Load failed|Error:)/i.test(line)) {
    chunks.push(textChunk(line, c.red, c.bold));
    return;
  }
  if (index === 0) {
    const split = line.indexOf('All harnesses') >= 0 ? line.indexOf('All harnesses') : line.search(/Claude Code|OpenCode/);
    if (split > 0) {
      chunks.push(textChunk(line.slice(0, split), c.cyan, c.bold));
      chunks.push(textChunk(line.slice(split), c.muted));
    } else chunks.push(textChunk(line, c.cyan, c.bold));
    return;
  }
  if (line.startsWith(' Synced ')) {
    chunks.push(textChunk(' Synced', c.green, c.bold));
    chunks.push(textChunk(line.slice(7), c.muted));
    return;
  }

  const tokenPattern = /(◷ \S+|⌂ [^│║]+?(?=  ⎇|[│║]?$)|⎇ [^│║]+(?=[│║]?$)|\[CC\]|\[OC\]|\[CX\]|\[PI\]|\[YOU\]|\[ASSISTANT\]|\[EVENT\]|\[SYSTEM\]|❯|▶|▼|●|◆|✓|!|○|★|├──|└──|│|[╔╗╚╝║═┌┐└┘─]+|Ctrl\+K|\b(?:Enter|Tab|PgUp|PgDn|j\/k|f|g|o|r|q|u)\b)/g;
  let start = 0;
  for (const match of line.matchAll(tokenPattern)) {
    if (match.index > start) chunks.push(textChunk(line.slice(start, match.index), c.fg));
    const token = match[0];
    if (token === '[CC]') chunks.push(textChunk(token, c.amber, c.bold));
    else if (token === '[OC]') chunks.push(textChunk(token, c.blue, c.bold));
    else if (token === '[CX]') chunks.push(textChunk(token, c.green, c.bold));
    else if (token === '[PI]') chunks.push(textChunk(token, c.magenta, c.bold));
    else if (token === '[YOU]') chunks.push(textChunk(token, c.cyan, c.bold));
    else if (token === '[ASSISTANT]') chunks.push(textChunk(token, c.magenta, c.bold));
    else if (token === '[EVENT]' || token === '[SYSTEM]') chunks.push(textChunk(token, c.amber, c.bold));
    else if (token.startsWith('◷ ')) chunks.push(textChunk(token, c.cyan));
    else if (token.startsWith('⌂ ')) chunks.push(textChunk(token, c.magenta));
    else if (token.startsWith('⎇ ')) chunks.push(textChunk(token, c.green, c.bold));
    else if (token === '●' || token === '✓') chunks.push(textChunk(token, c.green, c.bold));
    else if (token === '◆' || token === '★') chunks.push(textChunk(token, c.amber, c.bold));
    else if (token === '!') chunks.push(textChunk(token, c.red, c.bold));
    else if (token === '○') chunks.push(textChunk(token, c.muted));
    else if (token === '❯') chunks.push(textChunk(token, c.cyan, c.bold));
    else if (token === '▶') chunks.push(textChunk(token, c.amber, c.bold));
    else if (token === '▼') chunks.push(textChunk(token, c.green, c.bold));
    else if (/^[╔╗╚╝║═]+$/.test(token)) chunks.push(textChunk(token, c.cyan));
    else if (/^[┌┐└┘─│├]+/.test(token)) chunks.push(textChunk(token, c.muted));
    else chunks.push(textChunk(token, c.magenta, c.bold));
    start = match.index + token.length;
  }
  if (start < line.length) chunks.push(textChunk(line.slice(start), c.fg));
}

function textChunk(text, fg = null, attributes = 0) {
  const chunk = {__isChunk: true, text};
  if (fg) chunk.fg = fg;
  if (attributes) chunk.attributes = attributes;
  return chunk;
}
export function normalizeKey(e) { if (e.ctrl && e.name === 'c') return 'ctrl+c'; if (e.ctrl && e.name === 'k') return 'ctrl+k'; const names = {return: 'enter', escape: 'esc'}; if (names[e.name]) return names[e.name]; if (['space', 'backspace', 'delete', 'pageup', 'pagedown', 'tab', 'up', 'down', 'left', 'right'].includes(e.name)) return e.name; if(e.shift&&String(e.name||'').length===1)return String(e.name).toUpperCase();return e.sequence?.length === 1 ? e.sequence : e.name || ''; }
const normalize=normalizeKey;
function columns(a, b) { return Array.from({length: Math.max(a.length, b.length)}, (_, i) => (a[i] || '').padEnd(a[0]?.length || 0) + ' ' + (b[i] || '')); }
function box(lines, width, title, active, height = null) { const h = active ? '═' : '─', v = active ? '║' : '│'; const bodyHeight = height == null ? lines.length : height - 2; const body = [...lines]; while (body.length < bodyHeight) body.push(''); return [(active ? '╔' : '┌') + title + h.repeat(Math.max(0, width - title.length - 2)) + (active ? '╗' : '┐'), ...body.slice(0, bodyHeight).map((line) => v + fit(line, width - 2).padEnd(width - 2) + v), (active ? '╚' : '└') + h.repeat(width - 2) + (active ? '╝' : '┘')]; }
function fit(value, width) { const text = String(value || ''); return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'; }
function oneLine(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function wrapText(value, width, maxLines) {
  const words = oneLine(value).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) line = next;
    else { if (line) lines.push(line); line = word; if (lines.length >= maxLines) break; }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.length && lines.join(' ').length < oneLine(value).length) lines[lines.length - 1] = fit(`${lines.at(-1) || ''}…`, width);
  return lines.length ? lines : ['Not available'];
}
function folderParts(value) {
  const full = String(value || 'Unknown folder').replace(process.env.HOME || '', '~').replace(/\/+$/, '');
  if (full === 'Unknown folder') return {name: full, parent: 'No working directory recorded'};
  const slash = full.lastIndexOf('/');
  return {name: slash >= 0 ? full.slice(slash + 1) || full : full, parent: slash >= 0 ? full.slice(0, slash) || '/' : 'workspace'};
}
function sessionTreeLine({active, branch, session, width}) {
  const lead = `${active ? '❯' : ' '}   ${branch} ${badge(session.harness)} `;
  const valueWidth = width >= 70 ? 18 : 8;
  const metadata = [`◷ ${age(session.updatedAt)}`, `⌂ ${fit(session.project || 'unknown', valueWidth)}`];
  if (session.branch) metadata.push(`⎇ ${fit(session.branch, valueWidth)}`);
  const right = metadata.join('  ');
  const left = `${lead}${session.title}`;
  const gap = width - left.length - right.length;
  if (gap >= 2) return `${left}${' '.repeat(gap)}${right}`;
  const availableTitle = Math.max(4, width - lead.length - right.length - 2);
  const prefix = `${lead}${fit(session.title, availableTitle)}`;
  return `${prefix}${' '.repeat(Math.max(2, width - prefix.length - right.length))}${right}`;
}
function contextLine(model) {
  const row = model.selectedRow();
  if (row?.type === 'lane') return `${laneGlyph(row.lane)} ${row.lane.toUpperCase()} · ${row.count} sessions · Enter toggles`;
  if (row?.type === 'event') return `${eventGlyph(row.event.type)} ${row.event.type} · ${row.event.harness}:${row.event.sessionId}`;
  if (row?.type === 'folder') return `${row.collapsed ? 'COLLAPSED' : 'EXPANDED'} FOLDER · ${folderParts(row.key).name} · Enter toggles`;
  if (row?.type === 'search') return `${badge(row.result.harness)} ${roleBadge(row.result.role)} ${row.result.project} · o resumes source session`;
  if (row?.type === 'ai-search') return `${badge(row.result.harness)} AI match ${row.result.confidence}% · o resumes exact session`;
  const session = row?.session;
  return session ? `${badge(session.harness)} ${session.title} · o resumes in this terminal · Enter previews` : 'Select a folder with j/k · Enter expands';
}
function renderPalette(model) {
  const width = Math.min(92, Math.max(58, model.width - 12));
  const items = model.paletteItems();
  const target = model.selected();
  const guidance = model.paletteMessage || (target ? 'Actions available for this session.' : 'Global actions available right now.');
  const lines = [`  TARGET  ${target ? `${badge(target.harness)} ${target.local.alias || target.title}` : 'No session selected'}`, `  ${guidance}`, '', `  › ${model.paletteQuery}`, '  ─────────────────────────────────────'];
  const start=Math.max(0,Math.min(model.paletteIndex-6,Math.max(0,items.length-12)));
  for (let index=start;index<Math.min(items.length,start+12);index++) { const item=items[index];lines.push(fit(`${index === model.paletteIndex ? '❯' : ' '} ${item.label}`, width - 2)); }
  if (!items.length) lines.push('  No matching commands or sessions.');
  lines.push('', '  Type to filter · ↑/↓ move · Enter run · Esc close');
  return box(lines, width, ' command palette ', true).join('\n');
}
function promptTitle(model) { if (model.promptKind === 'new-session') { const adapter = model.adapters.find((item) => item.id === model.pendingAction); return `NEW ${String(adapter?.name || model.pendingAction).toUpperCase()} SESSION · WORKING DIRECTORY`; } if(model.promptKind==='worktree')return 'NEW WORKTREE · BRANCH AND TARGET PATH';return model.promptKind === 'search' ? (model.view==='search'?'SEARCH LOCAL TRANSCRIPTS':'FILTER SESSIONS') : model.promptKind === 'confirm' ? `CONFIRM ${typeof model.pendingAction==='string'?model.pendingAction.toUpperCase():'WORKTREE CREATION'}` : `${model.promptKind.toUpperCase()} SESSION`; }
function commandCenterSessionLine(session, active, width, indent = '') { const lead = `${active ? '❯' : ' '} ${indent}${statusGlyph(session)} ${badge(session.harness)} ${session.local.alias || session.title}`; const right = `◷ ${age(session.updatedAt)}  ⌂ ${fit(session.project || 'unknown', 15)}`; const gap = width - lead.length - right.length; return fit(gap >= 2 ? `${lead}${' '.repeat(gap)}${right}` : `${lead}  ${right}`, width); }
function statusGlyph(session) { if (session.local?.pinned) return '★'; return {running: '●', waiting: '◆', completed: '✓', failed: '!', stale: '○', offline: '○'}[session.status] || '○'; }
function laneGlyph(lane) { return {waiting: '◆', running: '●', pinned: '★', snoozed: '◌', recent: '◷'}[lane] || '·'; }
function tokenTotal(session) { const tokens = session.tokens || {}; return Number(tokens.input || 0) + Number(tokens.output || 0) + Number(tokens.reasoning || 0); }
function diffSummary(session) { const git = session.git || {}; return git.additions || git.deletions ? ` · +${git.additions || 0}/-${git.deletions || 0}` : ''; }
function folderCount(model) { return new Set(model.filtered.map((session) => session.cwd || session.project || 'Unknown folder')).size; }
function visibleRowEnd(rows, start, lineBudget) {
  let used = 0;
  let end = start;
  while (end < rows.length) {
    const cost = rows[end].type === 'folder' ? 2 : 1;
    if (used + cost > lineBudget && end > start) break;
    used += cost;
    end += 1;
  }
  return end;
}
function badge(harness) { return harness === 'claude' ? '[CC]' : harness === 'opencode' ? '[OC]' : harness === 'codex' ? '[CX]' : harness === 'pi' ? '[PI]' : '[??]'; }
function roleBadge(role) { return role === 'user' ? '[YOU]' : role === 'assistant' ? '[ASSISTANT]' : role === 'system' ? '[SYSTEM]' : '[EVENT]'; }
function age(time) { const d = Date.now() - Number(time || 0), m = Math.floor(d / 60000); if (m < 1) return 'now'; if (m < 60) return `${m}m`; const h = Math.floor(m / 60); if (h < 24) return `${h}h`; const days = Math.floor(h / 24); return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`; }
function cleanError(error) { return String(error?.stderr || error?.message || error).trim().split('\n').pop().replace(/^Error:\s*/, ''); }
