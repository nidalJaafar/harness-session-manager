import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {canOpenTerminalWindow, newSessionLaunchMethod} from '../src/launch.mjs';
import {SessionHubModel, ONBOARDING_VERSION} from '../src/model.mjs';
import {StateStore} from '../src/state.mjs';
import {executeLaunch, render} from '../src/tui.mjs';

function temp(){return fs.mkdtempSync(path.join(os.tmpdir(),'hsm-launch-'));}
function fixture(){return{id:'s1',harness:'claude',harnessName:'Claude Code',title:'Fix SSH launch',project:'hsm',cwd:process.cwd(),updatedAt:10,resume:{command:'claude',args:['--resume','s1']},capabilities:{preview:true},git:{}};}
function adapter(rows=[fixture()]){return{id:'claude',name:'Claude Code',available:()=>true,newSession:{command:'claude',args:[]},sessions:async()=>rows,preview:async()=>[]};}
function setup(options={}){const store=new StateStore({dir:temp()});return{store,model:new SessionHubModel({adapters:[adapter()],store,processScanner:()=>[],...options})};}

test('new terminal windows are offered only in graphical local sessions',()=>{
  assert.equal(canOpenTerminalWindow({DISPLAY:':0'}),true);
  assert.equal(canOpenTerminalWindow({WAYLAND_DISPLAY:'wayland-0'}),true);
  assert.equal(canOpenTerminalWindow({SSH_TTY:'/dev/pts/1',DISPLAY:':0'}),false);
  assert.equal(canOpenTerminalWindow({}),false);
  assert.equal(newSessionLaunchMethod({DISPLAY:':0'}),'window');
  assert.equal(newSessionLaunchMethod({SSH_CONNECTION:'remote'}),'current');
});

test('o always resumes in the current terminal',async()=>{
  const {model}=setup({environment:{DISPLAY:':0'}});await model.load();model.selectedSession=model.rows().findIndex((row)=>row.session);
  assert.equal((await model.key('o')).method,'current');
  assert.equal(model.paletteItems().find((item)=>item.id==='resume').label,'Resume in this terminal');
  assert.equal(model.paletteItems().find((item)=>item.id==='resume-window').label,'Resume in a new terminal window');
});

test('new-terminal resume is hidden over SSH',async()=>{
  const {model}=setup({environment:{SSH_TTY:'/dev/pts/1'}});await model.load();model.selectedSession=model.rows().findIndex((row)=>row.session);
  assert.equal(model.paletteItems().some((item)=>item.id==='resume-window'),false);
});

test('palette keeps the active action visible while scrolling',async()=>{
  const row={...fixture(),capabilities:{preview:true,rename:true,archive:true}};
  const {model}=setup({adapters:[adapter([row])],environment:{DISPLAY:':0'}});await model.load();model.selectedSession=model.rows().findIndex((item)=>item.session);model.palette=true;
  const items=model.paletteItems();model.paletteIndex=items.length-1;
  assert.match(render(model),/❯ Hide session from HSM/);
});

test('current-terminal launch suspends, runs, resumes, reloads, and restores selection',async()=>{
  const {model}=setup();await model.load();model.setView('projects');model.collapsedFolders.clear();model.recompute();model.selectedSession=model.rows().findIndex((row)=>row.session);
  const calls=[],renderer={suspend:()=>calls.push('suspend'),resume:()=>calls.push('resume')};
  const result=await executeLaunch(model.openSelected(),{model,renderer,spawnSyncFn:(command,args,options)=>{calls.push([command,args,options.cwd]);return{status:0};}});
  assert.deepEqual(calls.slice(0,3),['suspend',['claude',['--resume','s1'],process.cwd()],'resume']);
  assert.equal(result.method,'current');assert.equal(model.selected().id,'s1');assert.match(model.status,/Returned from Claude Code/);
});

test('new-window launch stays detached and reports its pid',async()=>{
  const {model}=setup();const child=new EventEmitter();child.pid=42;child.unref=()=>{};let invocation;
  const result=await executeLaunch({type:'open',method:'window',command:'claude',args:[],cwd:process.cwd(),label:'Claude Code'},{model,renderer:{},environment:{TERMINAL:'foot --app-id hsm'},spawnFn:(command,args,options)=>{invocation={command,args,options};return child;}});
  assert.equal(result.pid,42);assert.equal(result.method,'window');assert.equal(invocation.command,'foot');assert.deepEqual(invocation.args,['--app-id','hsm','claude']);assert.equal(invocation.options.detached,true);
});

test('new-window launch reports asynchronous spawn errors',async()=>{
  const {model}=setup();const child=new EventEmitter();child.unref=()=>{};let redrawn=0;
  await executeLaunch({type:'open',method:'window',command:'claude',args:[],cwd:process.cwd()},{model,renderer:{},spawnFn:()=>child,redraw:()=>{redrawn++;}});
  child.emit('error',new Error('terminal unavailable'));
  assert.match(model.status,/terminal unavailable/);assert.equal(redrawn,1);
});

test('current-terminal launch resumes HSM and reports a nonzero child exit',async()=>{
  const {model}=setup();await model.load();const calls=[],renderer={suspend:()=>calls.push('suspend'),resume:()=>calls.push('resume')};
  await executeLaunch({type:'open',method:'current',command:'claude',args:[],cwd:process.cwd(),label:'Claude Code'},{model,renderer,spawnSyncFn:()=>({status:7})});
  assert.deepEqual(calls,['suspend','resume']);assert.match(model.status,/status 7/);
});

test('guided tour advances through real views and opens the action palette',async()=>{
  const {store,model}=setup();await model.load();model.startOnboardingIfNeeded();
  assert.equal(model.onboarding,true);assert.match(render(model),/guided tour · 1\/10/);assert.match(render(model),/Press Enter to begin/);
  await model.key('x');assert.equal(model.onboardingStep,0);
  await model.key('enter');assert.equal(model.onboardingStep,1);
  await model.key('2');assert.equal(model.view,'projects');assert.equal(model.onboardingStep,2);
  await model.key('1');assert.equal(model.view,'dashboard');assert.equal(model.onboardingStep,3);
  await model.key('/');assert.equal(model.view,'search');assert.equal(model.prompt,false);assert.equal(model.onboardingStep,4);
  await model.key('esc');assert.equal(model.view,'dashboard');assert.equal(model.onboardingStep,5);
  await model.key('ctrl+k');assert.equal(model.palette,true);assert.equal(model.onboardingStep,6);
  await model.key('esc');assert.equal(model.palette,false);assert.equal(model.onboardingStep,7);
  await model.key('enter');await model.key('enter');await model.key('enter');
  assert.equal(model.onboarding,false);assert.equal(store.state.ui.onboardingVersion,ONBOARDING_VERSION);
});

test('guided tour can be ended and replayed',async()=>{
  const {store,model}=setup();await model.load();model.startOnboarding();await model.key('esc');
  assert.equal(model.onboarding,false);assert.equal(store.state.ui.onboardingVersion,ONBOARDING_VERSION);
  model.startOnboardingIfNeeded();assert.equal(model.onboarding,false);model.startOnboarding();assert.equal(model.onboarding,true);
});
