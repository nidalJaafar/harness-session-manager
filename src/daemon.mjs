import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sessionKey, quote} from './state.mjs';
import {IntelligenceIndex} from './intelligence.mjs';

const UNIT='hsm.service';
export class HsmDaemon {
  constructor(store,{exec=execFileSync,executable=process.argv[1],unitDir=path.join(os.homedir(),'.config/systemd/user')}={}){this.store=store;this.exec=exec;this.executable=path.resolve(executable);this.unitDir=unitDir;this.unitPath=path.join(unitDir,UNIT);}
  install(){fs.mkdirSync(this.unitDir,{recursive:true});fs.writeFileSync(this.unitPath,`[Unit]\nDescription=HSM session monitor and local indexer\nAfter=graphical-session.target\n\n[Service]\nType=simple\nExecStart=${systemdEscape(this.executable)} daemon run\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`);this.systemctl('daemon-reload');this.systemctl('enable','--now',UNIT);return this.status();}
  remove(){try{this.systemctl('disable','--now',UNIT);}catch{}if(fs.existsSync(this.unitPath))fs.unlinkSync(this.unitPath);this.systemctl('daemon-reload');return{installed:false,active:false};}
  start(){this.systemctl('start',UNIT);return this.status();} stop(){this.systemctl('stop',UNIT);return this.status();}
  status(){const installed=fs.existsSync(this.unitPath);let active=false;try{this.exec('systemctl',['--user','is-active','--quiet',UNIT],{stdio:'ignore'});active=true;}catch{}return{installed,active,unit:this.unitPath};}
  systemctl(...args){try{return this.exec('systemctl',['--user',...args],{encoding:'utf8'});}catch(error){if(args.includes('--quiet'))return{status:error.status??1};throw new Error(`systemd user service failed: ${error.stderr?.toString().trim()||error.message}`);}}
}
export class NotificationMonitor {
  constructor(store,{notify=desktopNotify,now=()=>Date.now()}={}){this.store=store;this.notify=notify;this.now=now;}
  tick(){let count=0;const latest=new Map();for(const event of this.store.events(1000))if(!latest.has(sessionKey(event.harness,event.sessionId)))latest.set(sessionKey(event.harness,event.sessionId),event);for(const [key,event] of latest){if(!['waiting','notification','failed','error'].includes(event.type))continue;const meta=this.store.metadataFresh(key);if(Number(meta.snoozedUntil||0)>this.now())continue;const old=this.store.query(`select state,event_timestamp as eventTimestamp from notifications where session_key=${quote(key)}`)[0];const state=['failed','error'].includes(event.type)?'failed':'waiting';if(old?.state===state&&Number(old.eventTimestamp)>=event.timestamp)continue;this.notify(state==='failed'?'HSM session failed':'HSM session needs input',`${event.harness} · ${event.cwd||event.sessionId}`);this.store.exec(`insert or replace into notifications values(${quote(key)},${quote(state)},${event.timestamp},${this.now()})`);count++;}return count;}
}
export function desktopNotify(title,body){execFileSync('notify-send',['--app-name=HSM',title,body],{stdio:'ignore'});}
export async function runDaemon(store,{interval=2000,indexInterval=30000,signal=process}={}){const monitor=new NotificationMonitor(store),index=new IntelligenceIndex(store);let stopped=false,lastIndex=0,lastErrorAt=0,adapters=[];try{const {createHarnessAdapters}=await import('./harnesses/index.mjs');adapters=await createHarnessAdapters({});}catch(error){report(error);}signal.once?.('SIGTERM',()=>{stopped=true;});signal.once?.('SIGINT',()=>{stopped=true;});while(!stopped){try{monitor.tick();}catch(error){report(error);}if(Date.now()-lastIndex>=indexInterval){lastIndex=Date.now();try{const sessions=(await Promise.all(adapters.map((adapter)=>adapter.sessions().catch(()=>[])))).flat();await index.indexSessions(sessions,adapters);}catch(error){report(error);}}await new Promise((resolve)=>setTimeout(resolve,interval));}function report(error){if(Date.now()-lastErrorAt<60000)return;lastErrorAt=Date.now();console.error(`hsm daemon: ${String(error?.stderr||error?.message||error).trim().split('\n').pop()}`);}}
function systemdEscape(value){return String(value).replaceAll('\\','\\x5c').replaceAll(' ','\\x20');}
