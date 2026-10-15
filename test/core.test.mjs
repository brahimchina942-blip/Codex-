import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { DEMO } from '../lib/demo.mjs';
import { validateAnalysis, decodeImages, overlap } from '../lib/core.mjs';
import { createQwen } from '../lib/qwen.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'morocco-crm-test-')),store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,dir};
}
function importDraft(store,customer,analysis=structuredClone(DEMO),images=[]) {
  const d=store.saveDraft({customerId:customer.id,analysis,images});
  const result=store.commit(d.id,{customerId:customer.id,messages:analysis.messages,acceptedFacts:analysis.facts.map((f,index)=>({index,value:f.value}))});
  return {draft:d,result};
}
test('同字段变化保留旧事实，20CBM成为当前事实',t=>{
  const {store}=fixture(t),c=store.createCustomer({name:'Amine'});
  importDraft(store,c);
  const volume=store.detail(c.id).facts.filter(f=>f.field==='volume');
  assert.equal(volume.find(f=>f.value==='15 CBM').state,'superseded');
  assert.equal(volume.find(f=>f.value==='20 CBM').state,'active');
  assert.ok(volume.every(f=>f.evidence_message_id));
});
test('客户之间的上下文、档案和消息互相隔离',t=>{
  const {store}=fixture(t),a=store.createCustomer({name:'Mohammed'}),b=store.createCustomer({name:'Mohammed'});
  importDraft(store,a);
  assert.equal(store.detail(b.id).messages.length,0);
  assert.equal(store.context(b.id,'家具').facts.length,0);
  assert.ok(!JSON.stringify(store.context(b.id,'家具')).includes('20 CBM'));
});
test('用A上下文得到的分析不能归档到B',t=>{
  const {store}=fixture(t),a=store.createCustomer({name:'A'}),b=store.createCustomer({name:'B'});
  const d=store.saveDraft({customerId:a.id,analysis:structuredClone(DEMO)});
  assert.throws(()=>store.commit(d.id,{customerId:b.id,messages:DEMO.messages,acceptedFacts:[]}),/重新分析/);
  assert.equal(store.detail(b.id).messages.length,0);
  assert.equal(store.draft(d.id).status,'ready');
});
test('同一截图重复导入不增加消息或事实，仍保留来源',t=>{
  const {store}=fixture(t),c=store.createCustomer({name:'A'});
  const image=decodeImages([{data:'data:image/png;base64,iVBORw0KGgo=',name:'fixture.png'}]);
  importDraft(store,c,structuredClone(DEMO),image);
  const first=store.detail(c.id).facts.length;
  const {result}=importDraft(store,c,structuredClone(DEMO),image);
  assert.equal(result.inserted,0);assert.equal(result.skipped,3);
  assert.equal(store.detail(c.id).messages.length,3);assert.equal(store.detail(c.id).facts.length,first);
  assert.equal(store.detail(c.id).messages[0].screenshots.length,2);
});
test('相邻连续两条重叠可以去重；独立Merci不会跨历史误删',()=>{
  assert.equal(overlap(DEMO.messages,DEMO.messages.slice(1)),2);
  const m={speaker:'customer',original:'Merci',visible_time:''};
  assert.equal(overlap([m],[m]),0);
});
test('人工校对消息会使关联事实待复核并停用旧建议',t=>{
  const {store}=fixture(t),c=store.createCustomer({name:'A'});importDraft(store,c);
  const message=store.detail(c.id).messages[2];
  store.editMessage(message.id,c.id,{...message,original:'Actually 25 CBM',chinese:'实际上是25立方米'});
  const d=store.detail(c.id);
  assert.equal(d.facts.find(f=>f.value==='20 CBM').state,'needs_review');
  assert.equal(d.latest.stale,true);
  assert.ok(!store.context(c.id).facts.some(f=>f.value==='20 CBM'));
});
test('删除消息时关联事实删除，旧回复停用',t=>{
  const {store}=fixture(t),c=store.createCustomer({name:'A'});importDraft(store,c);
  const m=store.detail(c.id).messages[2];store.deleteMessage(m.id,c.id);
  assert.equal(store.detail(c.id).messages.length,2);
  assert.ok(!store.detail(c.id).facts.some(f=>f.evidence_message_id===m.id));
  assert.equal(store.detail(c.id).latest.stale,true);
});
test('数据库重启后客户记忆依旧存在',()=>{
  const dir=mkdtempSync(join(tmpdir(),'morocco-persist-'));let store=new Store(dir);
  try{const c=store.createCustomer({name:'持久客户'});importDraft(store,c);store.close();store=new Store(dir);assert.equal(store.detail(c.id).messages.length,3);assert.equal(store.detail(c.id).facts.filter(f=>f.state==='active'&&f.field==='volume')[0].value,'20 CBM');}
  finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('模型输出中的越界事实来源、非法角色和缺失中文被拒绝',()=>{
  for(const mutate of [a=>a.facts[0].message_index=999,a=>a.facts[0].field='constructor',a=>a.messages[0].speaker='admin',a=>delete a.messages[0].chinese]){
    const a=structuredClone(DEMO);mutate(a);assert.throws(()=>validateAnalysis(a),/缺少有效字段/);
  }
});
test('拒绝伪装图片、SVG和超出数量限制的上传',()=>{
  assert.throws(()=>decodeImages([{data:'data:image/png;base64,aGVsbG8='}]),/不符/);
  assert.throws(()=>decodeImages([{data:'data:image/svg+xml;base64,aGVsbG8='}]),/仅支持/);
  assert.throws(()=>decodeImages(new Array(6).fill({})),/最多/);
});
test('千问调用携带隔离上下文与JSON要求，密钥仅作为服务端请求头',async()=>{
  let captured;
  const qwen=createQwen({apiKey:'private-test-key',baseUrl:'https://example.invalid/v1',model:'qwen3.7-plus',thinking:false,timeout:1000},async(url,options)=>{
    captured={url:String(url),...options};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(DEMO)},finish_reason:'stop'}]}));
  });
  const result=await qwen({text:'Salam',images:[],context:{customer:{name:'A'},facts:[]}});
  assert.equal(result.messages.length,3);assert.equal(captured.headers.Authorization,'Bearer private-test-key');
  assert.ok(!captured.body.includes('private-test-key'));assert.equal(JSON.parse(captured.body).response_format.type,'json_object');
  assert.ok(JSON.parse(captured.body).messages[1].content[0].text.includes('"name":"A"'));
});
test('千问错误不能泄露上游密钥与响应正文',async()=>{
  const qwen=createQwen({apiKey:'secret-key',baseUrl:'https://example.invalid/v1',model:'qwen3.7-plus',timeout:1000},async()=>new Response('secret-key debug output',{status:401}));
  await assert.rejects(()=>qwen({text:'hello',images:[],context:{}}),e=>e.message.includes('401')&&!e.message.includes('secret-key'));
});
test('未配置接口时明确失败，不能伪造任意翻译',async()=>{
  await assert.rejects(()=>createQwen({})({text:'hello',images:[],context:{}}),/尚未配置/);
});
