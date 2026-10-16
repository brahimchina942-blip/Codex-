import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,statSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { createReferenceReplies } from '../lib/qwen.mjs';
import { DEMO } from '../lib/demo.mjs';

const config={host:'127.0.0.1',port:0,password:'reference-test-password',origin:'',apiKey:'sk-synthetic-reference-fixture',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.7-plus',thinking:false,timeout:2000};
const reply=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const company={title:'公司介绍 · 测试资料',category:'公司介绍',content:'测试公司提供中国至摩洛哥货代服务。',scope:'公司介绍，不代表每票均包含清关。'};
const fee={title:'家具类佣金 · 测试资料',category:'佣金/费率',content:'测试佣金比例1%，基数为已确认货值；不含税费。',scope:'仅家具类；基数及币种须另行确认。',keywords:'家具,furniture,meubles'};
async function setup(t,fetcher){
  const dataDir=mkdtempSync(join(tmpdir(),'crm-references-')),{server,store}=createApp({...config,dataDir},{qwenFetcher:fetcher});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dataDir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,body,method=body===undefined?'GET':'POST',headers={})=>{const r=await fetch(url+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,headers:r.headers,body:await r.json()};};
  const login=await call('/api/login',{password:config.password}),cookie=login.headers.get('set-cookie').split(';')[0];
  return {store,dataDir,call:(path,body,method,headers={})=>call(path,body,method,{Cookie:cookie,...headers}),anonymous:call};
}

test('公共资料可持久化增删改查；佣金必须有适用条件，停用/过期/内部资料不进入回复',t=>{
  const dir=mkdtempSync(join(tmpdir(),'crm-library-'));let store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  assert.throws(()=>store.library.save({...fee,scope:''}),/适用/);assert.throws(()=>store.library.save({...fee,valid_until:'2026-02-30'}),/日期/);
  const intro=store.library.save(company),price=store.library.save(fee);
  const disabled=store.library.save({...fee,title:'停用费率',enabled:false}),expired=store.library.save({...fee,title:'过期费率',valid_until:'2000-01-01'}),internal=store.library.save({...fee,title:'内部资料',usage:'internal'});
  assert.deepEqual(new Set(store.library.select('meubles 家具',{facts:[]}).map(e=>e.id)),new Set([intro.id,price.id]));
  assert.ok(store.library.list().some(e=>e.id===expired.id&&!e.available));assert.ok(!store.library.eligible().some(e=>[disabled.id,internal.id].includes(e.id)));
  assert.equal(store.library.list('家具类佣金').length,1);const old=store.library.revision();store.library.save({content:'测试佣金已修改，需人工确认'},price.id);assert.notEqual(store.library.revision(),old);
  store.close();store=new Store(dir);assert.match(store.library.get(price.id).content,/已修改/);assert.equal(statSync(join(dir,'company-knowledge.sqlite')).mode&0o777,0o600);
  store.library.remove(price.id);assert.throws(()=>store.library.get(price.id),/不存在/);assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,2);
});

test('资料库接口需登录和同源，在未选择客户时也可管理，并为所有客户共用',async t=>{
  const a=await setup(t,async()=>reply(DEMO));
  assert.equal((await a.anonymous('/api/references')).status,401);assert.equal((await a.anonymous('/api/references',company)).status,401);
  assert.equal((await a.call('/api/references',company,'POST',{Origin:'https://evil.invalid'})).status,403);
  const created=await a.call('/api/references',company);assert.equal(created.status,201);
  const first=a.store.createCustomer({name:'客户一'}),second=a.store.createCustomer({name:'客户二'});
  assert.equal((await a.call('/api/references')).body.entries[0].id,created.body.id);
  assert.equal(a.store.detail(first.id).messages.length,0);assert.equal(a.store.detail(second.id).messages.length,0);
  assert.equal((await a.call(`/api/references/${created.body.id}`,{title:'新的公司介绍'},'PATCH')).status,200);
  assert.equal((await a.call(`/api/references/${created.body.id}`,undefined,'DELETE')).status,200);assert.equal((await a.call('/api/references')).body.entries.length,0);
});

test('图片识别后匹配通用资料和类目佣金，跨聊天共用且不混入客户事实、内部资料或其他客户内容',async t=>{
  const calls=[];
  const a=await setup(t,async(url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    if(Array.isArray(body.messages[1].content))return reply(DEMO);
    const data=JSON.parse(body.messages[1].content);return reply({replies:DEMO.replies.map(r=>({...r,reference_ids:data.references.map(e=>e.id)})),facts:[{field:'quote',value:'不应写入客户事实'}]});
  });
  const intro=a.store.library.save(company),price=a.store.library.save(fee);
  const internal=a.store.library.save({...fee,content:'INTERNAL-SHOULD-NOT-BE-SENT',usage:'internal'});
  const cars=a.store.library.save({...fee,title:'汽车配件类规则',scope:'仅轮毂',keywords:'汽车,轮毂,hub',content:'UNRELATED-CAR-COMMISSION'});
  const first=a.store.createCustomer({name:'家具客户'}),other=a.store.createCustomer({name:'不可泄漏的其他客户'});
  const privateAnalysis=structuredClone(DEMO);privateAnalysis.messages[0].original='OTHER-CUSTOMER-PRIVATE-MESSAGE';const saved=a.store.saveDraft({customerId:other.id,analysis:privateAnalysis});a.store.commit(saved.id,{customerId:other.id,messages:privateAnalysis.messages,acceptedFacts:[]});
  const result=await a.call('/api/analyze',{customer_id:first.id,images:[{name:'fixture.png',data:'data:image/png;base64,iVBORw0KGgo='}]});assert.equal(result.status,201);
  assert.equal(calls.length,2);const referenceInput=JSON.parse(calls[1].messages[1].content);
  assert.deepEqual(new Set(referenceInput.references.map(e=>e.id)),new Set([intro.id,price.id]));assert.ok(!JSON.stringify(calls).includes('INTERNAL-SHOULD-NOT-BE-SENT'));assert.ok(!JSON.stringify(calls).includes('UNRELATED-CAR-COMMISSION'));assert.ok(!JSON.stringify(calls).includes('OTHER-CUSTOMER-PRIVATE-MESSAGE'));
  assert.deepEqual(result.body.analysis.facts,DEMO.facts);assert.equal(a.store.detail(first.id).facts.length,0);assert.equal(result.body.analysis.reference_sources.length,2);assert.ok(!JSON.stringify(result.body.analysis.reference_sources).includes(price.content));
  const secondResult=await a.call('/api/analyze',{customer_id:other.id,text:'meubles furniture 家具'});assert.equal(secondResult.status,201);assert.ok(secondResult.body.analysis.reference_sources.some(e=>e.id===price.id));
  assert.ok(!referenceInput.references.some(e=>[internal.id,cars.id].includes(e.id)));
});

test('公共资料更改后旧回复失效，更新回复不会改变聊天事实或摘要',async t=>{
  const a=await setup(t,async(url,options)=>{const body=JSON.parse(options.body);if(Array.isArray(body.messages[1].content))return reply(DEMO);const data=JSON.parse(body.messages[1].content);return reply({replies:DEMO.replies.map(r=>({...r,reference_ids:data.references.map(e=>e.id)}))});});
  const doc=a.store.library.save(company),customer=a.store.createCustomer({name:'资料更新客户'});
  const created=await a.call('/api/analyze',{customer_id:customer.id,text:'Bonjour meubles'}),draft=created.body;
  a.store.commit(draft.id,{customerId:customer.id,messages:draft.analysis.messages,acceptedFacts:[]});
  const before=a.store.detail(customer.id),snapshot=JSON.stringify(before.messages);
  a.store.library.save({content:'已修订的测试公司介绍'},doc.id);
  const stale=(await a.call(`/api/customers/${customer.id}`)).body.latest;assert.equal(stale.references_stale,true);assert.equal(stale.stale,false);assert.equal(stale.summary,before.latest.summary);
  const updated=await a.call(`/api/customers/${customer.id}/replies/refresh`,{draft_id:draft.id,shipment_id:null});assert.equal(updated.status,200);assert.equal(updated.body.references_stale,false);assert.equal(updated.body.reference_revision,a.store.library.revision());assert.equal(JSON.stringify(a.store.messages(customer.id)),snapshot);
  a.store.library.remove(doc.id);assert.equal((await a.call(`/api/customers/${customer.id}`)).body.latest.references_stale,true);
  const noDocs=await a.call(`/api/customers/${customer.id}/replies/refresh`,{draft_id:draft.id});assert.equal(noDocs.status,200);assert.equal(noDocs.body.reference_sources.length,0);
});

test('资料库生成期间的改动不覆盖已保存回复；未知资料引用被拒绝',async t=>{
  let unblock,started;const gate=new Promise(resolve=>{unblock=resolve;}),ready=new Promise(resolve=>{started=resolve;});
  const a=await setup(t,async(url,options)=>{const data=JSON.parse(JSON.parse(options.body).messages[1].content);started();await gate;return reply({replies:DEMO.replies.map(r=>({...r,reference_ids:data.references.map(e=>e.id)}))});});
  const doc=a.store.library.save(company),customer=a.store.createCustomer({name:'并发测试'}),draft=a.store.saveDraft({customerId:customer.id,analysis:structuredClone(DEMO)});a.store.commit(draft.id,{customerId:customer.id,messages:DEMO.messages,acceptedFacts:[]});
  const before=JSON.stringify(a.store.draft(draft.id).analysis),pending=a.call(`/api/customers/${customer.id}/replies/refresh`,{draft_id:draft.id});await ready;a.store.library.save({content:'翻译期间更新'},doc.id);unblock();assert.equal((await pending).status,409);assert.equal(JSON.stringify(a.store.draft(draft.id).analysis),before);
  await assert.rejects(()=>createReferenceReplies(config,async()=>reply({replies:DEMO.replies.map(r=>({...r,reference_ids:['not-provided']}))}))({analysis:DEMO,context:{},references:[]}),/未提供/);
});

test('备份包含公共资料库和客户数据库，独立恢复后仍有资料条目',t=>{
  const dir=mkdtempSync(join(tmpdir(),'crm-reference-backup-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const doc=store.library.save(company);store.createCustomer({name:'备份客户'});
  execFileSync(process.execPath,[resolve('scripts/backup.mjs')],{cwd:dir,env:{...process.env,DATA_DIR:dir},stdio:'pipe'});
  const target=join(dir,'backups',readdirSync(join(dir,'backups'))[0]);
  const knowledge=new DatabaseSync(join(target,'company-knowledge.sqlite'),{readOnly:true});try{assert.equal(knowledge.prepare('SELECT title FROM entries WHERE id=?').get(doc.id).title,company.title);}finally{knowledge.close();}
  assert.equal(statSync(join(target,'company-knowledge.sqlite')).mode&0o777,0o600);assert.ok(statSync(join(target,'crm.sqlite')).size>0);
});
