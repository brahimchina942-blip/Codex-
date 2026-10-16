import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createReplyTranslator } from '../lib/qwen.mjs';
import { Store } from '../lib/store.mjs';
import { DEMO } from '../lib/demo.mjs';
import { decodeImages } from '../lib/core.mjs';

const config={host:'127.0.0.1',port:0,password:'reply-test-password',origin:'',apiKey:'sk-synthetic-reply-fixture',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.7-plus',thinking:false,timeout:1000};
const response=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));

test('自定义中文回复多语翻译需登录和同源，保留所选顺序且不会建档或外发消息',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'crm-replies-')),calls=[];
  const {server,store}=createApp({...config,dataDir:dir},{qwenFetcher:async(url,options)=>{
    calls.push({url:String(url),options});return response({translations:[{language:'fr',text:'Merci de confirmer le volume de 2 CBM.'},{language:'en',text:'Please confirm the volume of 2 CBM.'}]});
  }});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`,payload={text:'请确认体积为2 CBM。',languages:['en','fr']};
  const post=async(path,body,cookie='',headers={})=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/replies/translate',payload)).status,401);
  const login=await post('/api/login',{password:config.password}),cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/replies/translate',payload,cookie,{Origin:'https://evil.invalid'})).status,403);
  for(const languages of [[],['xx'],['en','en'],['__proto__']])assert.equal((await post('/api/replies/translate',{...payload,languages},cookie)).status,400);
  assert.equal((await post('/api/replies/translate',{...payload,text:''},cookie)).status,400);
  const result=await post('/api/replies/translate',payload,cookie);assert.equal(result.status,200);
  const value=await result.json();assert.deepEqual(value.translations.map(t=>t.language),['en','fr']);assert.match(value.translations[0].text,/2 CBM/);
  assert.equal(calls.length,1);const body=JSON.parse(calls[0].options.body);
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+config.apiKey);assert.ok(!calls[0].options.body.includes(config.apiKey));
  assert.equal(JSON.parse(body.messages[1].content).source_text,payload.text);assert.equal(body.enable_thinking,false);
  assert.equal(store.customers().length,0);assert.equal(store.readyDrafts().length,0);assert.equal(store.db.prepare('SELECT count(*) AS count FROM messages').get().count,0);
});

test('不接受缺少语言、重复语言、空翻译或截断回复；千问鉴权错误不暴露密钥',async()=>{
  for(const translations of [[],[{language:'en',text:'ok'},{language:'en',text:'duplicate'}],[{language:'en',text:'ok'},{language:'ar',text:''}]]){
    const translate=createReplyTranslator(config,async()=>response({translations}));
    await assert.rejects(()=>translate({text:'你好',languages:['en','ar']}),/翻译/);
  }
  await assert.rejects(()=>createReplyTranslator(config,async()=>new Response(config.apiKey,{status:401}))({text:'你好',languages:['en']}),error=>error.status===502&&!error.message.includes(config.apiKey));
  await assert.rejects(()=>createReplyTranslator(config,async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]})))({text:'你好',languages:['en']}),/超过输出限制/);
});

function archive(store,customerId,shipmentId,analysis,images=[]){
  const draft=store.saveDraft({customerId,shipmentId,analysis,images});store.commit(draft.id,{customerId,shipmentId,messages:analysis.messages,acceptedFacts:analysis.facts.map((f,index)=>({index,value:f.value}))});return draft;
}
test('全部记忆覆盖当前客户所有批次和运输需求，搜索不缩小总结；本次图片总结仍独立',t=>{
  const dir=mkdtempSync(join(tmpdir(),'crm-memory-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const customer=store.createCustomer({name:'记忆测试客户'}),other=store.createCustomer({name:'其他客户'});
  const a=store.createShipment(customer.id,{title:'家具到卡萨布兰卡'}),b=store.createShipment(customer.id,{title:'服装到丹吉尔'});
  const first=structuredClone(DEMO);first.summary='第一批家具沟通总结';archive(store,customer.id,a.id,first);
  const next=structuredClone(DEMO);next.summary='本次服装图片总结';next.messages=[{...next.messages[0],original:'Vêtements 8 CBM Tanger',chinese:'服装8立方米运往丹吉尔'}];next.facts=[{field:'volume',value:'8 CBM',certainty:'stated',message_index:0}];
  const images=decodeImages([{name:'fixture.png',data:'data:image/png;base64,iVBORw0KGgo='}]);archive(store,customer.id,b.id,next,images);
  const detail=store.detail(customer.id,'不存在的搜索词',b.id);
  assert.equal(detail.messages.length,0);assert.equal(detail.memory.message_count,4);assert.equal(detail.memory.record_count,2);
  const sectionA=detail.memory.sections.find(s=>s.shipment_id===a.id),sectionB=detail.memory.sections.find(s=>s.shipment_id===b.id);
  assert.match(sectionA.text,/20 CBM/);assert.ok(!sectionA.text.includes('15 CBM'));assert.ok(!sectionA.text.includes('8 CBM'));assert.match(sectionB.text,/8 CBM/);
  assert.equal(detail.latest.summary,'本次服装图片总结');assert.equal(detail.latest.screenshots.length,1);
  assert.equal(store.detail(customer.id,'',a.id).latest.summary,'第一批家具沟通总结');assert.equal(store.detail(other.id).memory.sections.length,0);
  const pending=store.saveDraft({customerId:customer.id,shipmentId:b.id,analysis:{...next,summary:'未归档草稿'}});
  assert.equal(store.detail(customer.id,'',b.id).latest.summary,'本次服装图片总结');assert.equal(store.detail(customer.id).memory.record_count,2);assert.equal(store.draft(pending.id).status,'ready');
});

test('校对与删除来源后全部记忆即时排除无效内容，本次总结标为失效',t=>{
  const dir=mkdtempSync(join(tmpdir(),'crm-memory-invalidate-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const customer=store.createCustomer({name:'来源测试'});archive(store,customer.id,null,structuredClone(DEMO));
  const fact=store.detail(customer.id).facts.find(f=>f.value==='20 CBM'),message=store.messages(customer.id).find(m=>m.id===fact.evidence_message_id);
  store.editMessage(message.id,customer.id,{...message,chinese:'改为需要人工复核的文字'});
  const updated=store.detail(customer.id);assert.ok(!JSON.stringify(updated.memory.sections).includes('20 CBM'));assert.ok(updated.memory.needs_review_count>0);assert.equal(updated.latest.stale,true);
  store.deleteMessage(message.id,customer.id);assert.equal(store.detail(customer.id).memory.message_count,2);
});
