import {quote, sessionKey} from './state.mjs';

export class IntelligenceIndex {
  constructor(store) { this.store = store; }
  paused() { return Boolean(this.store.getKv('index_paused')); }
  exclusions() { return this.store.getKv('index_exclusions') || []; }
  backend(){return this.store.getKv('search_backend')||'like';}
  status() { const table=this.backend()==='fts5'?'messages_fts':'indexed_messages';return {paused:this.paused(),backend:this.backend(),sessions:Number(this.store.query('select count(*) as n from indexed_sessions')[0]?.n || 0),messages:Number(this.store.query(`select count(*) as n from ${table}`)[0]?.n || 0),exclusions:this.exclusions(),integrity:this.store.integrity()}; }
  pause(value = true) { this.store.setKv('index_paused', value); return this.status(); }
  exclude(project) { const values=[...new Set([...this.exclusions(),project])]; this.store.setKv('index_exclusions',values); for(const row of this.store.query(`select session_key as sessionKey from indexed_sessions where cwd=${quote(project)} or cwd like ${quote(`${project}/%`)}`))this.deleteSession(row.sessionKey); return values; }
  async indexSessions(sessions, adapters, {force=false, limit=200}={}) {
    if (this.paused()) return {indexed:0,paused:true}; let indexed=0;
    const exclusions=this.exclusions();
    const indexedSessions=new Map(this.store.query('select session_key as sessionKey,updated_at as updatedAt from indexed_sessions').map((row)=>[row.sessionKey,Number(row.updatedAt||0)]));
    const table=this.backend()==='fts5'?'messages_fts':'indexed_messages';
    for (const session of sessions.slice(0,limit)) {
      if (exclusions.some((value) => session.cwd === value || session.cwd?.startsWith(`${value}/`))) continue;
      const key=sessionKey(session),oldUpdatedAt=indexedSessions.get(key)||0;
      if (!force && oldUpdatedAt >= Number(session.updatedAt || 0)) continue;
      const adapter=adapters.find((item)=>item.id===session.harness); if (!adapter) continue;
      let messages=[]; try { messages=typeof adapter.messagesSince==='function' ? await adapter.messagesSince(session,oldUpdatedAt) : await adapter.preview(session); } catch { continue; }
      try {
        const columns='session_key,harness,session_id,project,branch,role,content,created_at,paths';
        const inserts=messages.map((message)=>`insert into ${table}(${columns}) values(${quote(key)},${quote(session.harness)},${quote(session.id)},${quote(session.project)},${quote(session.branch)},${quote(message.role)},${quote(message.text)},${Number(message.createdAt || session.updatedAt || 0)},${quote(extractPaths(message.text).join(' '))});`).join('\n');
        this.store.exec(`begin; delete from ${table} where session_key=${quote(key)}; ${inserts} insert or replace into indexed_sessions values(${quote(key)},${quote(session.harness)},${quote(session.id)},${quote(session.title)},${quote(session.project)},${quote(session.cwd)},${quote(session.branch)},${quote(session.status)},${Number(session.updatedAt || 0)},${Date.now()}); commit;`); indexed++;
      } catch (error) { throw error; }
    }
    return {indexed,paused:false};
  }
  clear() { const table=this.backend()==='fts5'?'messages_fts':'indexed_messages';this.store.exec(`delete from ${table}; delete from indexed_sessions`); }
  deleteSession(key) { const table=this.backend()==='fts5'?'messages_fts':'indexed_messages';this.store.exec(`delete from ${table} where session_key=${quote(key)}; delete from indexed_sessions where session_key=${quote(key)}`); }
  facetValues(field, limit=40) {
    if(!['harness','project','branch'].includes(field))return[];
    if(field==='project'){
      const values=[];
      for(const row of this.store.query('select project,cwd from indexed_sessions order by lower(project),lower(cwd)'))for(const value of [row.project,String(row.cwd||'').split(/[\\/]/).filter(Boolean).pop()])if(value&&!values.some((item)=>item.toLowerCase()===value.toLowerCase()))values.push(value);
      return values.slice(0,Number(limit));
    }
    const table=this.backend()==='fts5'?'messages_fts':'indexed_messages';
    return this.store.query(`select distinct ${field} as value from ${table} where ${field} is not null and ${field}!='' order by lower(${field}) limit ${Number(limit)}`).map((row)=>row.value);
  }
  search(input, limit=100) {
    const {terms,facets}=parseQuery(input); if (!terms && !Object.keys(facets).length) return [];
    if(this.backend()!=='fts5')return this.searchLike(terms,facets,limit);
    const clauses=terms?[`messages_fts match ${quote(ftsExpression(terms))}`]:[];
    for (const [field,value] of Object.entries(facets)) clauses.push(facetClause(field,value));
    const snippet=terms?`snippet(messages_fts,6,'[',']','…',18)`:'substr(content,1,240)';
    const order=terms?'rank':'created_at desc';
    return this.store.query(`select session_key as sessionKey,harness,session_id as sessionId,project,branch,role,${snippet} as snippet,created_at as createdAt,paths from messages_fts where ${clauses.join(' and ')} order by ${order} limit ${Number(limit)}`);
  }
  searchLike(terms,facets,limit){const words=String(terms).split(/\s+/).filter(Boolean),clauses=words.map((term)=>`instr(lower(content),${quote(term.toLowerCase())})>0`);for(const [field,value] of Object.entries(facets))clauses.push(facetClause(field,value));return this.store.query(`select session_key as sessionKey,harness,session_id as sessionId,project,branch,role,substr(content,1,240) as snippet,created_at as createdAt,paths from indexed_messages where ${clauses.join(' and ')} order by created_at desc limit ${Number(limit)}`).map((row)=>({...row,snippet:highlight(row.snippet,words)}));}
  related(session, limit=8) {
    const key=sessionKey(session);
    const branch=session.branch||'__hsm_no_branch__';return this.store.query(`select session_key as sessionKey,harness,session_id as sessionId,title,project,branch,updated_at as updatedAt,((project=${quote(session.project)})*3+(branch!='' and branch=${quote(branch)})*4+(cwd=${quote(session.cwd)})*2) as score from indexed_sessions where session_key!=${quote(key)} and (project=${quote(session.project)} or branch=${quote(branch)} or cwd=${quote(session.cwd)}) order by score desc,updated_at desc limit ${Number(limit)}`);
  }
}

export function parseQuery(input) { const facets={}; const rest=[]; for (const token of String(input).match(/(?:[^\s"]+|"[^"]*")+/g)||[]) { const match=token.match(/^(harness|project|branch):(.+)$/); if (match) facets[match[1]]=match[2].replace(/^"|"$/g,''); else rest.push(token); } return {terms:rest.join(' ').trim(),facets}; }
function facetClause(field,value){const normalized=quote(String(value).toLowerCase());if(field==='project')return `(instr(lower(project),${normalized})>0 or session_key in (select session_key from indexed_sessions where instr(lower(project),${normalized})>0 or instr(lower(cwd),${normalized})>0))`;return `lower(${field})=${normalized}`;}
function ftsExpression(terms){return (String(terms).match(/"[^"]+"|[^\s]+/g)||[]).map((term)=>`"${term.replace(/^"|"$/g,'').replaceAll('"','""')}"`).join(' ');}
function extractPaths(text='') { return [...new Set(String(text).match(/(?:\.?\.?\/)?(?:[\w.-]+\/)+[\w.-]+/g)||[])].slice(0,20); }
function highlight(text,words){let value=String(text||'');for(const word of words)value=value.replace(new RegExp(escapeRegex(word),'ig'),(match)=>`[${match}]`);return value;}
function escapeRegex(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
