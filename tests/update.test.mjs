import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {UpdateManager} from '../src/update.mjs';
import {render} from '../src/tui.mjs';

function store(){let value=null;return{getKv:()=>value,setKv:(_key,next)=>{value=next;}};}

test('update checker caches the newest stable semantic version',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'hsm-check-'));fs.writeFileSync(path.join(root,'package.json'),'{"version":"1.0.0"}');const state=store(),manager=new UpdateManager(state,{root,now:()=>100,run:async()=>({stdout:'aaa\trefs/tags/v1.0.0\nbbb\trefs/tags/v1.2.0\nccc\trefs/tags/v1.1.5\n'})});const result=await manager.check({force:true});assert.equal(result.available,true);assert.equal(result.currentVersion,'1.0.0');assert.equal(result.latestVersion,'1.2.0');assert.deepEqual(await manager.check(),result);});

test('updater fast-forwards only to the newest stable tag and reruns installer',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'hsm-update-'));fs.mkdirSync(path.join(root,'.git'));fs.writeFileSync(path.join(root,'package.json'),'{"version":"1.0.0"}');const calls=[];let revisions=0;const runSync=(command,args)=>{calls.push([command,args]);if(command==='git'&&args.includes('status'))return'';if(command==='git'&&args.includes('rev-parse'))return++revisions===1?'old123\n':'new456\n';if(command==='git'&&args.includes('tag'))return'v1.0.0\nv1.2.0\nv1.1.0\n';if(command==='git'&&args.includes('rev-list'))return'new456\n';if(command==='systemctl')throw new Error('inactive');return'';};const result=new UpdateManager(store(),{root,runSync,now:()=>100}).update();assert.equal(result.updated,true);assert.ok(calls.some(([command,args])=>command==='git'&&args.includes('--ff-only')));assert.ok(calls.some(([command,args])=>command==='git'&&args.includes('rev-list')&&args.includes('v1.2.0')));assert.ok(calls.some(([command])=>command===path.join(root,'install.sh')));});

test('footer displays the available release without changing the main views',()=>{const model={help:false,launcher:false,palette:false,prompt:false,width:100,height:24,view:'dashboard',sessions:[],filtered:[],sources:[{name:'All harnesses'}],selectedSource:0,selected:()=>null,rows:()=>[],selectedRow:()=>null,collapsedFolders:new Set(),scroll:0,status:'Synced',updateInfo:{available:true,latestVersion:'1.2.0'}};assert.match(render(model),/HSM 1.2.0 is available · run hsm update/);});
