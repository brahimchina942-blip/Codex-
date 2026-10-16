import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError, object, str, sha, retrievalTerms } from './core.mjs';

export const REFERENCE_CATEGORIES=['公司介绍','佣金/费率','服务说明','常见问题','其他资料'];
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const normal=value=>value.normalize('NFKC').toLowerCase();
const terms=value=>[...new Set([...retrievalTerms(value),...(normal(value).match(/[\p{Script=Han}]{2,}/gu)||[]).flatMap(part=>Array.from({length:part.length-1},(_,i)=>part.slice(i,i+2)))])];

export class ReferenceLibrary{
  constructor(dataDir){
    const path=join(dataDir,'company-knowledge.sqlite');
    try{if(!lstatSync(path).isFile())throw new Error('公共资料库路径无效。');}catch(error){if(error.code!=='ENOENT')throw error;}
    this.db=new DatabaseSync(path);chmodSync(path,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    if(this.db.prepare('PRAGMA user_version').get().user_version>1){this.db.close();throw new Error('公共资料库版本不支持降级。');}
    this.db.exec(`CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,title TEXT NOT NULL,category TEXT NOT NULL,content TEXT NOT NULL,scope TEXT NOT NULL,keywords TEXT NOT NULL,usage TEXT NOT NULL,enabled INTEGER NOT NULL,valid_until TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);PRAGMA user_version=1;`);
  }
  close(){this.db.close();}
  list(query=''){
    const q=normal(query.trim()),day=today();
    return this.db.prepare('SELECT * FROM entries ORDER BY rowid DESC').all().map(row=>({...row,enabled:!!row.enabled,available:!!row.enabled&&(!row.valid_until||row.valid_until>=day)}))
      .filter(row=>!q||normal([row.title,row.category,row.content,row.scope,row.keywords].join(' ')).includes(q));
  }
  get(id){const entry=this.list().find(entry=>entry.id===id);if(!entry)throw new HttpError(404,'资料条目不存在。');return entry;}
  validate(input){
    if(!object(input))throw new HttpError(400,'请填写资料内容。');
    const category=input.category??'其他资料',usage=input.usage??'reply';
    if(!REFERENCE_CATEGORIES.includes(category)||!['reply','internal'].includes(usage))throw new HttpError(400,'资料分类或用途不正确。');
    if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new HttpError(400,'启用状态不正确。');
    const scope=str(input.scope??'',1500),validUntil=str(input.valid_until??'',10);
    if(category==='佣金/费率'&&!scope)throw new HttpError(400,'请填写佣金或费率的适用类目及条件。');
    if(validUntil&&(!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)||!Number.isFinite(Date.parse(validUntil))||new Date(validUntil).toISOString().slice(0,10)!==validUntil))throw new HttpError(400,'有效期日期不正确。');
    return {title:str(input.title,160,true),category,content:str(input.content,12000,true),scope,keywords:str(input.keywords??'',600),usage,enabled:input.enabled??true,valid_until:validUntil};
  }
  save(input,id=null){
    const previous=id?this.get(id):null,value=this.validate(previous?{...previous,...input}:input),now=new Date().toISOString();
    if(id)this.db.prepare('UPDATE entries SET title=?,category=?,content=?,scope=?,keywords=?,usage=?,enabled=?,valid_until=?,updated_at=? WHERE id=?').run(value.title,value.category,value.content,value.scope,value.keywords,value.usage,Number(value.enabled),value.valid_until,now,id);
    else{id=randomUUID();this.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,value.title,value.category,value.content,value.scope,value.keywords,value.usage,Number(value.enabled),value.valid_until,now,now);}
    return this.get(id);
  }
  remove(id){this.get(id);this.db.prepare('DELETE FROM entries WHERE id=?').run(id);}
  revision(){return sha(JSON.stringify(this.list().map(entry=>[entry.id,entry.title,entry.category,entry.content,entry.scope,entry.keywords,entry.usage,entry.available,entry.valid_until])));}
  eligible(){return this.list().filter(entry=>entry.available&&entry.usage==='reply');}
  select(text,context={}){
    const query=normal([text,...(context.facts||[]).map(f=>f.value),context.shipment?.title||'',context.shipment?.notes||''].join(' '));
    const ranked=this.eligible().map(entry=>{
      const words=terms([entry.title,entry.scope,entry.keywords].join(' '));
      const aliases=entry.keywords.split(/[,，;；\n]/).map(word=>normal(word.trim())).filter(Boolean);
      const score=aliases.reduce((score,word)=>score+(query.includes(word)?20:0),0)+words.reduce((score,word)=>score+(query.includes(normal(word))?2:0),0);
      const general=entry.category==='公司介绍'||(entry.category==='服务说明'&&!entry.scope&&!entry.keywords);
      return {entry,score:score+(general?3:0)};
    }).filter(row=>row.score>0).sort((a,b)=>b.score-a.score);
    const selected=[];let length=0;
    for(const {entry} of ranked){const size=JSON.stringify(entry).length;if(selected.length>=8||length+size>32000)continue;selected.push(entry);length+=size;}
    return selected;
  }
}
