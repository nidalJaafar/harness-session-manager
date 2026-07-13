import fs from 'node:fs';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);
const DEFAULT_REPOSITORY='https://github.com/nidalJaafar/harness-session-manager.git';
const CHECK_INTERVAL=6*60*60*1000;
export const HSM_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export class UpdateManager {
  constructor(store,{root=HSM_ROOT,repository=DEFAULT_REPOSITORY,now=()=>Date.now(),run=execFileAsync,runSync=execFileSync}={}){this.store=store;this.root=root;this.repository=repository;this.now=now;this.run=run;this.runSync=runSync;}
  currentVersion(){try{return String(JSON.parse(fs.readFileSync(path.join(this.root,'package.json'),'utf8')).version||'0.0.0');}catch{return'0.0.0';}}
  currentCommit(){try{return this.runSync('git',['-C',this.root,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return'';}}
  cached(){const info=this.store.getKv('update_check')||{},currentVersion=this.currentVersion();if(info.currentVersion!==currentVersion)return{...info,available:false,currentVersion};return info;}
  async check({force=false}={}){if(process.env.HSM_DISABLE_UPDATE_CHECK==='1')return{available:false,disabled:true};const cached=this.cached();if(!force&&cached.checkedAt&&this.now()-cached.checkedAt<CHECK_INTERVAL)return cached;const currentVersion=this.currentVersion();try{const {stdout}=await this.run('git',['ls-remote','--tags','--refs',this.repository,'v*'],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024});const latestVersion=latestSemver(stdout.split('\n').map((line)=>line.match(/refs\/tags\/v(\d+\.\d+\.\d+)$/)?.[1]).filter(Boolean));return this.save({currentVersion,latestVersion,available:Boolean(latestVersion&&compareSemver(latestVersion,currentVersion)>0),checkedAt:this.now()});}catch(error){return this.save({currentVersion,latestVersion:'',available:false,checkedAt:this.now(),error:shortError(error)});}}
  update(){if(!fs.existsSync(path.join(this.root,'.git')))throw new Error('This HSM installation is not a Git checkout. Reinstall using INSTALL.md.');const dirty=this.runSync('git',['-C',this.root,'status','--porcelain'],{encoding:'utf8'}).trim();if(dirty)throw new Error('Update stopped because the HSM checkout has local changes. Commit or discard them first.');const before=this.currentCommit(),beforeVersion=this.currentVersion();this.runSync('git',['-C',this.root,'fetch','--quiet','--tags','origin'],{stdio:'inherit'});const tags=this.runSync('git',['-C',this.root,'tag','--list','v[0-9]*'],{encoding:'utf8'}).trim().split('\n').filter(Boolean),latestVersion=latestSemver(tags.map((tag)=>tag.slice(1)));if(!latestVersion||compareSemver(latestVersion,beforeVersion)<=0){this.save({currentVersion:beforeVersion,latestVersion:latestVersion||'',available:false,checkedAt:this.now()});return{updated:false,before,after:before,beforeVersion,afterVersion:beforeVersion};}const tag=`v${latestVersion}`,target=this.runSync('git',['-C',this.root,'rev-list','-n','1',tag],{encoding:'utf8'}).trim();try{this.runSync('git',['-C',this.root,'merge-base','--is-ancestor',before,target],{stdio:'ignore'});}catch{throw new Error(`Update stopped because this checkout cannot fast-forward to ${tag}. Reinstall or resolve the Git history manually.`);}this.runSync('git',['-C',this.root,'merge','--ff-only',target],{stdio:'inherit'});this.runSync(path.join(this.root,'install.sh'),[],{cwd:this.root,stdio:'inherit'});const after=this.currentCommit(),afterVersion=this.currentVersion();this.save({currentVersion:afterVersion,latestVersion:afterVersion,available:false,checkedAt:this.now()});restartDaemon(this.runSync);return{updated:true,before,after,beforeVersion,afterVersion};}
  save(patch){const value={...patch,checkedAt:patch.checkedAt||this.now()};this.store.setKv('update_check',value);return value;}
}

function restartDaemon(runSync){try{runSync('systemctl',['--user','is-active','--quiet','hsm.service'],{stdio:'ignore'});runSync('systemctl',['--user','restart','hsm.service'],{stdio:'ignore'});}catch{}}
function shortError(error){return String(error?.stderr||error?.message||error).trim().split('\n').pop();}
function latestSemver(versions){return versions.filter(validSemver).sort(compareSemver).at(-1)||'';}
function validSemver(value){return /^\d+\.\d+\.\d+$/.test(String(value));}
function compareSemver(left,right){const a=String(left).split('.').map(Number),b=String(right).split('.').map(Number);for(let i=0;i<3;i++){const difference=(a[i]||0)-(b[i]||0);if(difference)return difference;}return 0;}
