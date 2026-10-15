import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createApp,readConfig } from '../server.mjs';
import { DEMO } from '../lib/demo.mjs';

async function app(t,password=''){
  const dataDir=mkdtempSync(join(tmpdir(),'morocco-api-'));
  const config={host:'127.0.0.1',port:0,password,origin:'',dataDir,apiKey:'',baseUrl:'',model:'qwen3.7-plus',thinking:false,timeout:1000};
  const {server,store}=createApp(config,{analyze:async()=>structuredClone(DEMO)});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dataDir,{recursive:true,force:true});});
  return {url,store,call:async(path,body,method='POST',headers={})=>{
    const r=await fetch(url+path,{method,headers:{'Content-Type':'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,value:await r.json(),headers:r.headers};
  }};
}
test('完整分析→人工确认→档案流程；未知角色必须先确认',async t=>{
  const a=await app(t),c=(await a.call('/api/customers',{name:'真实测试客户'})).value;
  const d=(await a.call('/api/analyze',{customer_id:c.id,text:'Salam'})).value;
  assert.equal(a.store.detail(c.id).messages.length,0);
  const wrong=structuredClone(d.analysis.messages);wrong[0].speaker='unknown';
  assert.equal((await a.call(`/api/drafts/${d.id}/commit`,{customer_id:c.id,messages:wrong,accepted_facts:[]})).status,400);
  const result=await a.call(`/api/drafts/${d.id}/commit`,{customer_id:c.id,messages:d.analysis.messages,accepted_facts:d.analysis.facts.map((f,index)=>({index,value:f.value}))});
  assert.equal(result.status,200);assert.equal(result.value.inserted,3);
  const details=await a.call(`/api/customers/${c.id}`,undefined,'GET');assert.equal(details.value.facts.filter(f=>f.field==='volume'&&f.state==='active')[0].value,'20 CBM');
  assert.equal((await a.call(`/api/drafts/${d.id}/commit`,{customer_id:c.id,messages:d.analysis.messages,accepted_facts:[]})).status,409);
});
test('非法审核索引和跨客户归属不会部分写入',async t=>{
  const a=await app(t),c=(await a.call('/api/customers',{name:'A'})).value,b=(await a.call('/api/customers',{name:'B'})).value;
  const d=(await a.call('/api/analyze',{customer_id:c.id,text:'hi'})).value;
  assert.equal((await a.call(`/api/drafts/${d.id}/commit`,{customer_id:c.id,messages:d.analysis.messages,accepted_facts:[{index:100,value:'bad'}]})).status,400);
  assert.equal((await a.call(`/api/drafts/${d.id}/commit`,{customer_id:b.id,messages:d.analysis.messages,accepted_facts:[]})).status,409);
  assert.equal(a.store.detail(c.id).messages.length,0);assert.equal(a.store.detail(b.id).messages.length,0);
});
test('登录保护读取、截图与导出，跨站请求和DNS重绑定Host被拒绝',async t=>{
  const a=await app(t,'example-password-123');
  assert.equal((await a.call('/api/customers',undefined,'GET')).status,401);
  assert.equal((await a.call('/api/login',{password:'wrong'})).status,401);
  const login=await a.call('/api/login',{password:'example-password-123'});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));
  assert.equal((await a.call('/api/customers',undefined,'GET',{Cookie:cookie})).status,200);
  assert.equal((await a.call('/api/customers',{name:'A'},'POST',{Cookie:cookie,Origin:'https://evil.invalid'})).status,403);
  // fetch 实现不会转发手工 Host，因此用原生 HTTP 真实构造重绑定请求。
  const forged=await new Promise((resolve,reject)=>{const req=request(a.url+'/api/customers',{headers:{Host:'evil.invalid',Cookie:cookie}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  assert.equal(forged,403);
  const c=(await a.call('/api/customers',{name:'保护测试'},'POST',{Cookie:cookie})).value;
  assert.equal((await a.call(`/api/customers/${c.id}/export`,undefined,'GET')).status,401);
  assert.equal((await a.call('/api/screenshots/00000000-0000-0000-0000-000000000000',undefined,'GET')).status,401);
});
test('静态页面有内容安全策略，状态接口不暴露环境密钥',async t=>{
  const a=await app(t);const r=await fetch(a.url);assert.equal(r.status,200);assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'"));assert.ok((await r.text()).includes('摩洛哥智能客户翻译助手'));
  const status=await a.call('/api/status',undefined,'GET');assert.equal(status.value.qwen_configured,false);assert.ok(!Object.hasOwn(status.value,'apiKey'));
});
test('从外站链接可打开登录页，跨站接口、登录提交和嵌入仍被拒绝',async t=>{
  const a=await app(t,'navigation-test-password');
  const login=await a.call('/api/login',{password:'navigation-test-password'});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const headers={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
  const navigate=(path,extra={},method='GET',body)=>new Promise((resolve,reject)=>{
    const req=request(a.url+path,{method,headers:{...headers,...extra}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;});
      res.on('end',()=>resolve({status:res.statusCode,text}));
    });req.on('error',reject);req.end(body);
  });
  const page=await navigate('/');
  assert.equal(page.status,200);assert.ok(page.text.includes('摩洛哥智能客户翻译助手'));
  assert.equal((await navigate('/api/customers',{Cookie:cookie})).status,403);
  assert.equal((await navigate('/api/status')).status,403);
  assert.equal((await navigate('/',{'Sec-Fetch-Dest':'iframe'})).status,403);
  assert.equal((await navigate('/',{'Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'})).status,403);
  assert.equal((await navigate('/api/login',{'Content-Type':'application/json'},'POST',JSON.stringify({password:'navigation-test-password'}))).status,403);
  assert.equal((await a.call('/api/customers',undefined,'GET')).status,401);
});
test('非回环地址未配置密码和明确访问地址时不能启动',()=>{
  assert.throws(()=>readConfig({HOST:'0.0.0.0'}),/必须配置/);
});
