import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createMemoryTranslator } from '../lib/qwen.mjs';
import { DEMO } from '../lib/demo.mjs';

const config={host:'127.0.0.1',port:0,password:'bilingual-fixture-password',origin:'',apiKey:'sk-synthetic-bilingual-fixture',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.7-plus',thinking:false,timeout:2000};
const response=items=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:items})}}]}));
async function fixture(t,fetcher){
  const dataDir=mkdtempSync(join(tmpdir(),'crm-bilingual-'));
  const {server,store}=createApp({...config,dataDir},{qwenFetcher:fetcher});
  const customer=store.createCustomer({name:'双语客户'}),other=store.createCustomer({name:'另一个客户'});
  const analysis=structuredClone(DEMO);analysis.facts=[{field:'volume',value:'Added 4 hubs, 67*67*36 cm each. Customs and taxes excluded.',certainty:'stated',message_index:0},{field:'goods',value:'汽车配件',certainty:'stated',message_index:0}];
  const draft=store.saveDraft({customerId:customer.id,analysis});store.commit(draft.id,{customerId:customer.id,messages:analysis.messages,acceptedFacts:analysis.facts.map((f,index)=>({index,value:f.value}))});
  const foreignDraft=store.saveDraft({customerId:other.id,analysis});store.commit(foreignDraft.id,{customerId:other.id,messages:analysis.messages,acceptedFacts:analysis.facts.map((f,index)=>({index,value:f.value}))});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dataDir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  async function call(path,body,cookie='',headers={}){const res=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:cookie,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,headers:res.headers,body:await res.json()};}
  const login=await call('/api/login',{password:config.password}),cookie=login.headers.get('set-cookie').split(';')[0];
  const path=`/api/customers/${customer.id}/memory/translate`,detail=store.detail(customer.id),fact=detail.facts.find(f=>f.field==='volume');
  return {store,customer,other,path,fact,call,cookie,input:{revision:detail.memory.revision,fact_ids:[fact.id]}};
}

test('旧外文记忆补中文并缓存，原文、正式事实和客户记录保持不变；已有中文即时显示来源原文',async t=>{
  let count=0;
  const a=await fixture(t,async(url,options)=>{count++;const input=JSON.parse(JSON.parse(options.body).messages[1].content);assert.equal(input.length,1);return response(input.map(f=>({id:f.id,chinese:'新增4个轮毂，每个67×67×36厘米，不含关税及税费。'})));});
  const before=JSON.stringify(a.store.detail(a.customer.id).facts),draftCount=a.store.db.prepare('SELECT count(*) AS n FROM drafts').get().n;
  const detail=(await a.call(`/api/customers/${a.customer.id}`,undefined,a.cookie)).body;
  const items=detail.memory.sections.flatMap(s=>s.items),chinese=items.find(i=>i.label==='采购货物');
  assert.equal(chinese.chinese,'汽车配件');assert.equal(chinese.original,DEMO.messages[0].original);
  assert.equal(items.find(i=>i.fact_id===a.fact.id).original,a.fact.value);
  const result=await a.call(a.path,a.input,a.cookie);assert.equal(result.status,200);assert.match(result.body.translations[0].chinese,/67×67×36厘米/);
  assert.equal((await a.call(a.path,a.input,a.cookie)).status,200);assert.equal(count,1);
  const restored=(await a.call(`/api/customers/${a.customer.id}`,undefined,a.cookie)).body.memory.sections.flatMap(s=>s.items).find(i=>i.fact_id===a.fact.id);
  assert.match(restored.chinese,/新增4个/);assert.equal(JSON.stringify(a.store.detail(a.customer.id).facts),before);assert.equal(a.store.db.prepare('SELECT count(*) AS n FROM drafts').get().n,draftCount);
});

test('双语翻译需登录及同源，不能读取其他客户事实或使用旧记忆版本',async t=>{
  let calls=0;const a=await fixture(t,async()=>{calls++;return response([]);});
  assert.equal((await a.call(a.path,a.input)).status,401);
  assert.equal((await a.call(a.path,a.input,a.cookie,{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await a.call(a.path,a.input,a.cookie,{'Sec-Fetch-Site':'cross-site'})).status,403);
  const otherFact=a.store.detail(a.other.id).facts[0];
  assert.equal((await a.call(a.path,{...a.input,fact_ids:[otherFact.id]},a.cookie)).status,400);
  assert.equal((await a.call(a.path,{...a.input,revision:'stale'},a.cookie)).status,409);
  assert.equal((await a.call(a.path,{...a.input,fact_ids:Array(11).fill(a.fact.id)},a.cookie)).status,400);assert.equal(calls,0);
});

test('来源在翻译期间被修改时拒绝缓存和显示旧译文',async t=>{
  let started,release;const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const a=await fixture(t,async(url,options)=>{const input=JSON.parse(JSON.parse(options.body).messages[1].content);started();await gate;return response(input.map(f=>({id:f.id,chinese:'旧来源的中文解释'})));});
  const pending=a.call(a.path,a.input,a.cookie);await ready;
  const message=a.store.messages(a.customer.id).find(m=>m.id===a.fact.evidence_message_id);a.store.editMessage(message.id,a.customer.id,{...message,chinese:'已校对的消息'});release();
  assert.equal((await pending).status,409);
  const detail=(await a.call(`/api/customers/${a.customer.id}`,undefined,a.cookie)).body;
  assert.ok(!JSON.stringify(detail.memory).includes('旧来源的中文解释'));assert.ok(!detail.memory.sections.flatMap(s=>s.items).some(i=>i.fact_id===a.fact.id));
});

test('不接受缺少ID、重复ID或未译成中文的长英文记忆，不暴露上游密钥',async()=>{
  const facts=[{id:'one',field:'volume',value:'Added four wheel hubs with packaging dimensions provided.'}];
  for(const value of [[],[{id:'wrong',chinese:'中文解释'}],[{id:'one',chinese:'Still English text'}]])
    await assert.rejects(()=>createMemoryTranslator(config,async()=>response(value))(facts),/记忆|中文/);
  await assert.rejects(()=>createMemoryTranslator(config,async()=>new Response(config.apiKey,{status:403}))(facts),e=>e.status===502&&!e.message.includes(config.apiKey));
});
