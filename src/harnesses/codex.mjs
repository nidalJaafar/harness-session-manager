import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export const DEFAULT_CODEX_HOME=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
export const DEFAULT_CODEX_DB=process.env.HSM_CODEX_DB||latestDatabase(DEFAULT_CODEX_HOME,'state')||path.join(DEFAULT_CODEX_HOME,'state_5.sqlite');
export const DEFAULT_CODEX_LOGS_DB=process.env.HSM_CODEX_LOGS_DB||latestDatabase(DEFAULT_CODEX_HOME,'logs')||path.join(DEFAULT_CODEX_HOME,'logs_2.sqlite');

export class CodexAdapter {
  constructor({codexHome=DEFAULT_CODEX_HOME,dbPath=DEFAULT_CODEX_DB,logsDbPath=DEFAULT_CODEX_LOGS_DB,sql=sqlite,now=()=>Date.now()}={}){this.id='codex';this.name='Codex';this.newSession={command:'codex',args:[]};this.codexHome=codexHome;this.dbPath=dbPath;this.logsDbPath=logsDbPath;this.sql=sql;this.now=now;}
  available(){return fs.existsSync(this.dbPath)||commandExists('codex');}
  async sessions(){if(!fs.existsSync(this.dbPath))return[];const rows=this.sql(this.dbPath,`select t.id,t.rollout_path,t.created_at,t.updated_at,t.created_at_ms,t.updated_at_ms,t.cwd,t.title,t.tokens_used,t.git_branch,t.model,t.agent_nickname,t.agent_role,t.source,t.thread_source,e.parent_thread_id from threads t left join thread_spawn_edges e on e.child_thread_id=t.id where coalesce(t.archived,0)=0 order by coalesce(t.updated_at_ms,t.updated_at*1000) desc;`);return rows.map((row)=>normalize(row)).filter(Boolean);}
  async preview(session){return rolloutMessages(session.raw.rolloutPath,{maxBytes:512*1024,maxMessages:8});}
  async messagesSince(session){return rolloutMessages(session.raw.rolloutPath,{maxBytes:1024*1024,maxMessages:20});}
  processes(){if(!fs.existsSync(this.logsDbPath))return[];try{return this.sql(this.logsDbPath,`select distinct thread_id from logs where thread_id is not null and ts>=${Math.floor(this.now()/1000)-10};`).map((row)=>({harness:'codex',sessionId:row.thread_id,pid:null,cwd:''}));}catch{return[];}}
  projectIdentity(session){return session.cwd||session.project;}
  prepareLaunch({cwd}){return{...this.newSession,cwd};}
}

function normalize(row){if(!row.id)return null;const cwd=row.cwd||'',createdAt=millis(row.created_at_ms,row.created_at),updatedAt=millis(row.updated_at_ms,row.updated_at);return{id:row.id,harness:'codex',harnessName:'Codex',title:summarize(row.title)||`Codex thread · ${row.id.slice(0,8)}`,project:path.basename(cwd)||'Unknown',cwd,branch:row.git_branch||'',tag:'',isSubagent:Boolean(row.parent_thread_id),parentId:row.parent_thread_id||'',model:row.model||'',agent:row.agent_nickname||row.agent_role||'',cost:null,tokens:{input:Number(row.tokens_used||0),output:0,reasoning:0},git:{branch:row.git_branch||'',dirty:false,files:0},capabilities:{rename:false,tag:false,archive:false,delete:false,move:false,preview:true,cost:false,git:true,liveEvents:false},createdAt,updatedAt,resume:{command:'codex',args:['resume',row.id]},raw:{rolloutPath:row.rollout_path||'',source:row.thread_source||row.source||''}};}

function rolloutMessages(file,{maxBytes,maxMessages}={}){if(!file||!fs.existsSync(file))return[];const messages=[];for(const entry of readJsonLinesTail(file,maxBytes)){if(entry.type!=='response_item'||entry.payload?.type!=='message')continue;const role=entry.payload.role;if(!['user','assistant'].includes(role))continue;const text=contentText(entry.payload.content);if(!text||isInjectedContext(text))continue;messages.push({role,text:text.length>2000?`${text.slice(0,1999)}…`:text,createdAt:Date.parse(entry.timestamp)||0});}return deduplicate(messages).slice(-(maxMessages||20));}
function contentText(content){if(typeof content==='string')return content.trim();if(!Array.isArray(content))return'';return content.filter((part)=>['input_text','output_text','text'].includes(part?.type)).map((part)=>part.text||'').join('\n').trim();}
function isInjectedContext(text){const value=String(text).trim();return value.startsWith('<environment_context>')||value.startsWith('<permissions instructions>')||value.startsWith('# AGENTS.md instructions')||value.startsWith('<INSTRUCTIONS>');}
function deduplicate(rows){const result=[];for(const row of rows)if(!result.length||result.at(-1).role!==row.role||result.at(-1).text!==row.text)result.push(row);return result;}
function readJsonLinesTail(file,maxBytes=2*1024*1024){const size=fs.statSync(file).size,start=Math.max(0,size-maxBytes),length=size-start,fd=fs.openSync(file,'r');try{const buffer=Buffer.allocUnsafe(length);fs.readSync(fd,buffer,0,length,start);let text=buffer.toString('utf8');if(start>0)text=text.slice(text.indexOf('\n')+1);return text.split('\n').filter(Boolean).map((line)=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);}finally{fs.closeSync(fd);}}
function millis(ms,seconds){return Number(ms||0)||Number(seconds||0)*1000;}
function summarize(value){const text=String(value||'').replace(/\s+/g,' ').trim();return text.length>120?`${text.slice(0,119)}…`:text;}
function sqlite(db,statement){const output=execFileSync('sqlite3',['-cmd','.timeout 10000','-json',db,statement],{encoding:'utf8',maxBuffer:32*1024*1024});return output.trim()?JSON.parse(output):[];}
function commandExists(command){try{execFileSync('which',[command],{stdio:'ignore'});return true;}catch{return false;}}
function latestDatabase(home,prefix){try{return fs.readdirSync(home).map((name)=>({name,match:name.match(new RegExp(`^${prefix}_(\\d+)\\.sqlite$`))})).filter((item)=>item.match).sort((a,b)=>Number(b.match[1])-Number(a.match[1])).map((item)=>path.join(home,item.name))[0]||'';}catch{return'';}}
