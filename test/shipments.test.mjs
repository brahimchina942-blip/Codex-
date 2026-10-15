import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';
import { DEMO } from '../lib/demo.mjs';
import { decodeImages, validateQuote } from '../lib/core.mjs';
import { createApp } from '../server.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'morocco-shipment-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, {recursive:true,force:true}); });
  const customer = store.createCustomer({name:'同一客户'});
  const a = store.createShipment(customer.id, {title:'家具 · 卡萨布兰卡'});
  const b = store.createShipment(customer.id, {title:'服装 · 丹吉尔'});
  return {store, dir, customer, a, b};
}
function commit(store, customerId, shipmentId, analysis=structuredClone(DEMO), images=[]) {
  const draft = store.saveDraft({customerId, shipmentId, analysis, images});
  const result = store.commit(draft.id, {customerId, shipmentId, messages:analysis.messages,
    acceptedFacts:analysis.facts.map((f,index) => ({index,value:f.value}))});
  return {draft, result};
}
const quote = (extra={}) => ({amount:'1250.50',currency:'USD',scope:'海运至港，不含税费、清关及派送',status:'已向客户报价',...extra});

test('同一客户两票货物各自保留当前体积和历史，上下文不串票', t => {
  const {store,customer,a,b} = fixture(t);
  commit(store,customer.id,a.id);
  const analysis = structuredClone(DEMO);
  analysis.messages[2].original='Vêtements, 8 CBM pour Tanger';
  analysis.messages[2].chinese='服装8立方米，到丹吉尔';
  analysis.facts=analysis.facts.filter(f=>f.field==='volume'&&f.value==='20 CBM');
  analysis.facts[0].value='8 CBM';
  commit(store,customer.id,b.id,analysis);
  const facts = store.detail(customer.id).facts;
  assert.equal(facts.find(f=>f.shipment_id===a.id&&f.value==='20 CBM').state,'active');
  assert.equal(facts.find(f=>f.shipment_id===a.id&&f.value==='15 CBM').state,'superseded');
  assert.equal(facts.find(f=>f.shipment_id===b.id&&f.value==='8 CBM').state,'active');
  const ca = store.context(customer.id,'体积',a.id), cb = store.context(customer.id,'体积',b.id);
  assert.ok(ca.facts.some(f=>f.value==='20 CBM'));
  assert.ok(!ca.facts.some(f=>f.value==='8 CBM'));
  assert.ok(!cb.recent_messages.some(m=>m.chinese.includes('实际上是20')));
  assert.equal(store.context(customer.id).recent_messages.length,0);
  assert.equal(store.latest(customer.id,a.id).shipment_id,a.id);
  assert.equal(store.latest(customer.id,b.id).shipment_id,b.id);
});

test('客户联系方式可跨该客户运输需求使用，货物事实不能', t => {
  const {store,customer,a,b} = fixture(t);
  const analysis = structuredClone(DEMO);
  analysis.facts.push({field:'contact',value:'+212 synthetic contact',certainty:'stated',message_index:0});
  commit(store,customer.id,a.id,analysis);
  const ctx = store.context(customer.id,'',b.id);
  assert.ok(ctx.facts.some(f=>f.field==='contact'));
  assert.ok(!ctx.facts.some(f=>f.field==='volume'));
});

test('分析绑定运输需求后禁止换票；跨客户运输需求禁止使用，失败无部分写入', t => {
  const {store,customer,a,b} = fixture(t);
  const draft = store.saveDraft({customerId:customer.id,shipmentId:a.id,analysis:structuredClone(DEMO)});
  assert.throws(()=>store.commit(draft.id,{customerId:customer.id,shipmentId:b.id,messages:DEMO.messages,acceptedFacts:[]}),/重新分析/);
  const other=store.createCustomer({name:'其他客户'});
  assert.throws(()=>store.saveDraft({customerId:other.id,shipmentId:a.id,analysis:DEMO}),/不存在/);
  assert.throws(()=>store.context(other.id,'',a.id),/不存在/);
  const unbound=store.saveDraft({analysis:structuredClone(DEMO)});
  assert.throws(()=>store.commit(unbound.id,{newCustomer:{name:'回滚客户'},shipmentId:a.id,messages:DEMO.messages,acceptedFacts:[]}),/不存在/);
  assert.equal(store.customers().length,2);
  assert.equal(store.detail(customer.id).messages.length,0);
  assert.equal(store.draft(unbound.id).status,'ready');
});

test('新客户与运输需求可原子建档；更换未绑定草稿归属会停用旧回复', t => {
  const {store} = fixture(t);
  const d=store.saveDraft({analysis:structuredClone(DEMO)});
  const r=store.commit(d.id,{newCustomer:{name:'新客户'},newShipment:{title:'家具到Casa'},messages:DEMO.messages,acceptedFacts:[]});
  assert.equal(store.shipment(r.shipment_id,r.customer_id).title,'家具到Casa');
  assert.equal(store.latest(r.customer_id,r.shipment_id).stale,true);
  assert.ok(store.messages(r.customer_id).every(m=>m.shipment_id===r.shipment_id));
});

test('相同截图在同票去重，在不同票独立保存', t => {
  const {store,customer,a,b} = fixture(t);
  const images=decodeImages([{name:'synthetic.png',data:'data:image/png;base64,iVBORw0KGgo='}]);
  commit(store,customer.id,a.id,structuredClone(DEMO),images);
  assert.equal(commit(store,customer.id,a.id,structuredClone(DEMO),images).result.inserted,0);
  assert.equal(commit(store,customer.id,b.id,structuredClone(DEMO),images).result.inserted,3);
  assert.equal(store.messages(customer.id).length,6);
});

test('报价严格关联客户及运输需求，保留多条金额及币种，录入使该票旧回复失效', t => {
  const {store,customer,a,b} = fixture(t);
  commit(store,customer.id,a.id); commit(store,customer.id,b.id);
  const message=store.messages(customer.id).find(m=>m.shipment_id===a.id);
  const q=store.createQuote(customer.id,a.id,quote({evidence_message_id:message.id}));
  store.createQuote(customer.id,a.id,quote({amount:'1300',currency:'EUR'}));
  assert.equal(store.quotes(customer.id,a.id).length,2);
  assert.equal(store.quotes(customer.id,a.id).find(x=>x.id===q.id).amount,'1250.50');
  assert.equal(store.context(customer.id,'',b.id).quotes.length,0);
  assert.equal(store.latest(customer.id,a.id).stale,true);
  assert.equal(store.latest(customer.id,b.id).stale,false);
  assert.throws(()=>store.createQuote(customer.id,b.id,quote({evidence_message_id:message.id})),/来源必须/);
  assert.equal(store.quotes(customer.id,b.id).length,0);
});

test('报价来源校对或删除后待复核且退出AI有效上下文，删除保留报价金额', t => {
  const {store,customer,a} = fixture(t);
  commit(store,customer.id,a.id);
  const message=store.messages(customer.id)[0];
  const q=store.createQuote(customer.id,a.id,quote({evidence_message_id:message.id}));
  store.editMessage(message.id,customer.id,{...message,chinese:'人工修正'});
  assert.equal(store.quotes(customer.id,a.id)[0].state,'needs_review');
  assert.equal(store.context(customer.id,'',a.id).quotes.length,0);
  store.deleteMessage(message.id,customer.id);
  const saved=store.quotes(customer.id,a.id).find(x=>x.id===q.id);
  assert.equal(saved.amount,'1250.50');assert.equal(saved.evidence_message_id,null);
  assert.equal(saved.state,'needs_review');
});

test('报价格式和真实日期校验；草稿及过期报价不作为有效参考', t => {
  const {store,customer,a} = fixture(t);
  for(const input of [{amount:'-1'},{amount:'0'},{amount:'1e3'},{amount:'1.234'},{currency:'XYZ'},{scope:''},{valid_until:'2026-02-30'},{valid_until:'nonsense'},{status:'自动发送'}])
    assert.throws(()=>validateQuote(quote(input)));
  store.createQuote(customer.id,a.id,quote({valid_until:'2000-01-01'}));
  store.createQuote(customer.id,a.id,quote({status:'草稿'}));
  store.createQuote(customer.id,a.id,quote({valid_until:'2099-12-31'}));
  const records=store.context(customer.id,'',a.id).quotes;
  assert.equal(records.filter(q=>q.usable_for_reference).length,1);
});

test('v1数据库迁移保留客户、消息、事实、草稿、截图和去重记录，重启幂等', () => {
  const dir=mkdtempSync(join(tmpdir(),'morocco-v1-'));
  const db=new DatabaseSync(join(dir,'crm.sqlite'));
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE customers(id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT DEFAULT '',city TEXT DEFAULT '',status TEXT DEFAULT '新询盘',preferred_language TEXT DEFAULT '',created_at TEXT,updated_at TEXT);
    CREATE TABLE drafts(id TEXT PRIMARY KEY,customer_id TEXT REFERENCES customers(id),analysis TEXT,demo INTEGER DEFAULT 0,status TEXT DEFAULT 'ready',created_at TEXT);
    CREATE TABLE screenshots(id TEXT PRIMARY KEY,draft_id TEXT REFERENCES drafts(id) ON DELETE CASCADE,hash TEXT,path TEXT,mime TEXT,name TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,customer_id TEXT REFERENCES customers(id),speaker TEXT,original TEXT,chinese TEXT,language TEXT,visible_time TEXT,uncertain INTEGER,draft_id TEXT REFERENCES drafts(id),signature TEXT,created_at TEXT);
    CREATE TABLE message_sources(message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,screenshot_id TEXT REFERENCES screenshots(id) ON DELETE CASCADE,PRIMARY KEY(message_id,screenshot_id));
    CREATE TABLE facts(id TEXT PRIMARY KEY,customer_id TEXT REFERENCES customers(id),field TEXT,value TEXT,certainty TEXT,state TEXT,evidence_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,created_at TEXT);
    CREATE TABLE receipts(customer_id TEXT REFERENCES customers(id),fingerprint TEXT,message_ids TEXT,PRIMARY KEY(customer_id,fingerprint));
    PRAGMA user_version=1;
  `);
  const now=new Date().toISOString();
  db.prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES (?,?,?,?)').run('old-customer','既有客户',now,now);
  db.prepare('INSERT INTO drafts(id,customer_id,analysis,status,created_at) VALUES (?,?,?,?,?)').run('old-draft','old-customer',JSON.stringify(DEMO),'committed',now);
  db.prepare('INSERT INTO screenshots VALUES (?,?,?,?,?,?)').run('old-image','old-draft','old-hash','uploads/old.png','image/png','旧截图');
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('old-message','old-customer','customer','15 CBM','15立方米','en','',0,'old-draft','old-signature',now);
  db.prepare('INSERT INTO message_sources VALUES (?,?)').run('old-message','old-image');
  db.prepare('INSERT INTO facts VALUES (?,?,?,?,?,?,?,?)').run('old-fact','old-customer','volume','15 CBM','stated','active','old-message',now);
  db.prepare('INSERT INTO receipts VALUES (?,?,?)').run('old-customer','old-fingerprint','["old-message"]');
  db.close();
  let store;
  try {
    store=new Store(dir);writeFileSync(join(dir,'uploads/old.png'),'preserved screenshot');
    const check=()=>{
      const detail=store.detail('old-customer');
      assert.equal(detail.customer.name,'既有客户');assert.equal(detail.messages.length,1);
      assert.equal(detail.messages[0].shipment_id,null);assert.equal(detail.messages[0].screenshots[0].id,'old-image');
      assert.equal(detail.facts[0].value,'15 CBM');assert.equal(detail.latest.id,'old-draft');
      assert.equal(store.db.prepare('SELECT shipment_scope FROM receipts').get().shipment_scope,'');
      assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,2);
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
      assert.equal(readFileSync(join(dir,'uploads/old.png'),'utf8'),'preserved screenshot');
    };
    check();store.close();store=new Store(dir);check();
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('运输需求及报价通过HTTP创建、审核归档、获取和导出，并拒绝跨票篡改', async t => {
  const dir=mkdtempSync(join(tmpdir(),'morocco-shipment-api-'));
  let context;
  const {server,store}=createApp({dataDir:dir,password:'',origin:''},{analyze:async input=>{context=input.context;return structuredClone(DEMO);}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,body,method=body===undefined?'GET':'POST')=>{
    const r=await fetch(url+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,value:await r.json()};
  };
  const c=(await call('/api/customers',{name:'HTTP客户'})).value;
  const base=`/api/customers/${c.id}/shipments`;
  assert.equal((await call(base,{title:''})).status,400);
  const a=(await call(base,{title:'家具'})).value,b=(await call(base,{title:'服装'})).value;
  assert.equal((await call(`${base}/${a.id}`,{status:'待报价'},'PATCH')).value.status,'待报价');
  const d=(await call('/api/analyze',{customer_id:c.id,shipment_id:a.id,text:'salut'})).value;
  assert.equal(context.shipment.id,a.id);assert.equal(d.shipment_id,a.id);
  const body={customer_id:c.id,shipment_id:a.id,messages:d.analysis.messages,accepted_facts:d.analysis.facts.map((f,index)=>({index,value:f.value}))};
  assert.equal((await call(`/api/drafts/${d.id}/commit`,{...body,shipment_id:b.id})).status,409);
  assert.equal((await call(`/api/drafts/${d.id}/commit`,body)).status,200);
  const detail=(await call(`/api/customers/${c.id}?shipment_id=${a.id}`)).value;
  assert.equal(detail.latest.shipment_id,a.id);assert.equal(detail.shipments.length,2);
  const q=await call(`${base}/${a.id}/quotes`,quote({evidence_message_id:detail.messages[0].id}));
  assert.equal(q.status,201);
  assert.equal((await call(`${base}/${b.id}/quotes`,quote({evidence_message_id:detail.messages[0].id}))).status,400);
  assert.equal((await call(`${base}/${a.id}/quotes`)).value.length,1);
  const exported=(await call(`/api/customers/${c.id}/export`)).value;
  assert.equal(exported.shipments.length,2);assert.equal(exported.quotes[0].amount,'1250.50');
  assert.equal((await call('/api/analyze',{shipment_id:a.id,text:'hello'})).status,400);
  const other=(await call('/api/customers',{name:'B'})).value;
  assert.equal((await call(`/api/customers/${other.id}/shipments/${a.id}/quotes`)).status,404);
  assert.equal((await call('/api/analyze',{customer_id:other.id,shipment_id:a.id,text:'hello'})).status,404);
});
