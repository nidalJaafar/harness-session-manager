import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CodexAdapter} from '../src/harnesses/codex.mjs';
import {builtinHarnesses} from '../src/harnesses/index.mjs';

test('Codex adapter discovers, previews, resumes, and classifies child threads',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hsm-codex-')),rollout=path.join(dir,'rollout.jsonl'),db=path.join(dir,'state.sqlite'),logs=path.join(dir,'logs.sqlite');fs.writeFileSync(db,'');fs.writeFileSync(logs,'');fs.writeFileSync(rollout,[
  {timestamp:'2026-01-01T00:00:00Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>hidden</environment_context>'}]}},
  {timestamp:'2026-01-01T00:00:01Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Fix the refresh race'}]}},
  {timestamp:'2026-01-01T00:00:02Z',type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Implemented the fix'}]}},
].map(JSON.stringify).join('\n'));const sql=(file)=>file===logs?[{thread_id:'cx-1'}]:[{id:'cx-1',rollout_path:rollout,cwd:dir,title:'Fix refresh race',tokens_used:1234,git_branch:'main',model:'gpt-5.6-codex',updated_at_ms:2000,created_at_ms:1000,parent_thread_id:'parent'}];const adapter=new CodexAdapter({dbPath:db,logsDbPath:logs,sql,now:()=>5000});const [session]=await adapter.sessions();assert.equal(session.harness,'codex');assert.equal(session.isSubagent,true);assert.equal(session.model,'gpt-5.6-codex');assert.deepEqual(session.resume,{command:'codex',args:['resume','cx-1']});assert.deepEqual((await adapter.preview(session)).map((item)=>item.text),['Fix the refresh race','Implemented the fix']);assert.deepEqual(adapter.processes(),[{harness:'codex',sessionId:'cx-1',pid:null,cwd:''}]);});

test('Codex is registered as a built-in pluggable harness',()=>{assert.ok(builtinHarnesses.some((item)=>item.id==='codex'&&item.name==='Codex'));});
