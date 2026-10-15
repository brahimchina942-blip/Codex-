import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { DEMO } from '../lib/demo.mjs';

async function setup(t, fetcher) {
  const dataDir=mkdtempSync(join(tmpdir(),'crm-settings-'));
  const config={host:'127.0.0.1',port:0,password:'settings-test-password',origin:'',dataDir,apiKey:'',baseUrl:'',model:'qwen3.7-plus',thinking:false,timeout:1000};
  let instance, url;
  async function start(){instance=createApp(config,{qwenFetcher:fetcher});await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${instance.server.address().port}`;}
  async function stop(){await new Promise(r=>instance.server.close(r));instance.store.close();}
  await start();t.after(async()=>{await stop();rmSync(dataDir,{recursive:true,force:true});});
  async function call(path,body,cookie,headers={}){
    const response=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  async function login(){return (await call('/api/login',{password:config.password})).headers.get('set-cookie').split(';')[0];}
  return {dataDir,call,login,restart:async()=>{await stop();await start();},drafts:()=>instance.store.readyDrafts()};
}
const candidate={api_key:'sk-synthetic-settings-fixture',base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.7-plus'};

test('千问设置需登录且拒绝跨站修改，不向状态或设置响应回显密钥',async t=>{
  const a=await setup(t),cookie=await a.login();
  for(const path of ['/api/settings/qwen','/api/settings/qwen/test']){
    assert.equal((await a.call(path,candidate)).status,401);
    assert.equal((await a.call(path,candidate,cookie,{Origin:'https://evil.invalid'})).status,403);
    assert.equal((await a.call(path,candidate,cookie,{'Sec-Fetch-Site':'cross-site'})).status,403);
  }
  assert.equal((await a.call('/api/settings/qwen')).status,401);
  const saved=await a.call('/api/settings/qwen',candidate,cookie);
  assert.equal(saved.status,200);assert.equal(saved.body.has_key,true);
  for(const body of [saved.body,(await a.call('/api/settings/qwen',undefined,cookie)).body,(await a.call('/api/status')).body]){
    assert.ok(!JSON.stringify(body).includes(candidate.api_key));assert.ok(!('apiKey' in body));assert.ok(!('api_key' in body));
  }
});

test('网页密钥私有持久化，留空沿用，重启后保留；测试不建档且新配置立即用于真实调用路径',async t=>{
  const calls=[];
  const a=await setup(t,async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(DEMO)}}]}));});
  let cookie=await a.login();
  assert.equal((await a.call('/api/settings/qwen/test',candidate,cookie)).status,200);
  assert.equal(a.drafts().length,0);
  assert.equal((await a.call('/api/status')).body.qwen_configured,false);
  assert.equal((await a.call('/api/settings/qwen',candidate,cookie)).status,200);
  const file=join(a.dataDir,'qwen-settings.json');assert.equal(statSync(file).mode&0o777,0o600);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).apiKey,candidate.api_key);
  assert.equal((await a.call('/api/settings/qwen',{...candidate,api_key:'',model:'qwen3-vl-plus'},cookie)).status,200);
  const draft=await a.call('/api/analyze',{text:'Bonjour'},cookie);
  assert.equal(draft.status,201);assert.equal(a.drafts().length,1);
  const latest=calls.at(-1);assert.equal(latest.options.headers.Authorization,'Bearer '+candidate.api_key);
  assert.equal(JSON.parse(latest.options.body).model,'qwen3-vl-plus');assert.ok(!latest.options.body.includes(candidate.api_key));
  await a.restart();cookie=await a.login();
  const restored=(await a.call('/api/settings/qwen',undefined,cookie)).body;
  assert.equal(restored.model,'qwen3-vl-plus');assert.equal(restored.has_key,true);
  assert.equal((await a.call('/api/settings/qwen/test',{},cookie)).status,200);
  assert.equal(a.drafts().length,1);
});

test('密钥只能发送到官方HTTPS百炼接口，上游错误不泄露密钥或响应内容',async t=>{
  let calls=0;
  const a=await setup(t,async()=>{calls++;return new Response(candidate.api_key+' private provider payload',{status:401});}),cookie=await a.login();
  for(const base_url of ['http://dashscope.aliyuncs.com/compatible-mode/v1','https://evil.invalid/compatible-mode/v1','https://dashscope.aliyuncs.com.evil.invalid/compatible-mode/v1','https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1','https://dashscope.aliyuncs.com/compatible-mode/v1?token=secret'])
    assert.equal((await a.call('/api/settings/qwen/test',{...candidate,base_url},cookie)).status,400);
  assert.equal(calls,0);
  const error=await a.call('/api/settings/qwen/test',candidate,cookie);
  assert.equal(error.status,502);assert.match(error.body.error,/401/);
  assert.ok(!JSON.stringify(error.body).includes(candidate.api_key));assert.ok(!JSON.stringify(error.body).includes('private provider payload'));
});
