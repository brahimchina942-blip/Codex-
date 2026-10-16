const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { customers:[], selected:null, shipment:null, detail:null, files:[], draft:null, replyStyle:'friendly', busy:false, status:{} };
const shipmentStatuses = ['询价中','待报价','待确认','运输中','已完成','已取消'];
const quoteStatuses = ['草稿','已向客户报价','客户已确认','已过期','已拒绝'];
const labels = { goods:'采购货物',origin:'中国货源地',destination:'收货城市',volume:'体积',weight:'重量',packages:'包装数量',shipping:'运输方式',terms:'交付范围',quote:'报价',contact:'联系方式',follow_up:'待跟进',language:'沟通语言' };
const styles = { professional:'专业商务',friendly:'自然友好',short:'简短直接' };
let toastTimer, selectionVersion=0, customerSearchTimer, chatSearchTimer;
function toast(message,error=false){$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});
  const value=await response.json();
  if(!response.ok){if(response.status===401 && !path.includes('/login'))$('login-dialog').showModal();throw new Error(value.error||'请求失败');}
  return value;
}
const post=(path,value)=>api(path,{method:'POST',body:JSON.stringify(value)});
function setPanel(panel){document.body.dataset.panel=panel;document.querySelectorAll('.mobile-nav button').forEach(b=>b.classList.toggle('selected',b.dataset.panel===panel));}
document.querySelectorAll('.mobile-nav button').forEach(b=>b.addEventListener('click',()=>setPanel(b.dataset.panel)));
function avatar(name){return [...name.trim()][0]?.toUpperCase()||'M';}
function time(value){return value?new Date(value).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'}):'';}
async function refreshCustomers(){state.customers=await api('/api/customers');renderCustomers();}
function renderCustomers(){
  const q=$('customer-search').value.toLowerCase().trim();
  const customers=state.customers.filter(c=>[c.name,c.phone,c.city,c.last_message||''].some(t=>t.toLowerCase().includes(q)));
  $('customer-count').textContent=state.customers.length;
  $('customer-list').innerHTML=customers.length?customers.map(c=>`<button class="client ${c.id===state.selected?'active':''}" data-customer="${esc(c.id)}"><div class="avatar">${esc(avatar(c.name))}</div><div class="client-copy"><div class="client-title"><strong>${esc(c.name)}</strong><small>${time(c.updated_at)}</small></div><p>${esc(c.last_message||c.city||'还没有聊天记录')}</p></div></button>`).join(''):`<div class="empty-list">${q?'没有匹配客户':'从一张截图开始<br>或点击 ＋ 建立客户档案'}</div>`;
  document.querySelectorAll('[data-customer]').forEach(b=>b.onclick=()=>selectCustomer(b.dataset.customer));
}
async function selectCustomer(id,shipment=null){
  state.selected=id;state.shipment=shipment;const version=++selectionVersion;renderCustomers();setPanel('chat');
  $('chat-area').innerHTML='<div class="loading-block">读取客户记忆…</div>';
  $('replies').hidden=true;$('profile-content').innerHTML='<div class="loading-block">读取客户记忆…</div>';
  try{const detail=await api(`/api/customers/${id}?shipment_id=${encodeURIComponent(shipment||'')}`);if(version!==selectionVersion)return;state.detail=detail;renderDetail();loadMemoryChinese(detail);}
  catch(e){toast(e.message,true);}
}
async function reloadDetail(){if(state.selected)await selectCustomer(state.selected,state.shipment);await refreshCustomers();}
const scopedMessages=messages=>messages.filter(m=>(m.shipment_id||null)===state.shipment);
function renderDetail(){
  const {customer,messages,facts,latest}=state.detail;
  $('active-name').textContent=customer.name;$('active-avatar').textContent=avatar(customer.name);
  $('active-meta').textContent=[customer.city,customer.preferred_language,customer.status].filter(Boolean).join(' · ');
  $('edit-customer').hidden=false;$('chat-search-wrap').hidden=false;$('chat-search').value='';
  $('demo-notice').hidden=!latest?.demo;
  $('shipment-bar').hidden=false;
  $('shipment-select').innerHTML=`<option value="">未分类 / 客户一般沟通</option>${state.detail.shipments.map(s=>`<option value="${s.id}" ${s.id===state.shipment?'selected':''}>${esc(s.title)} · ${esc(s.status)}</option>`).join('')}`;
  renderMessages(scopedMessages(messages));renderProfile(customer,facts,latest);renderReplies(latest);
}
function renderMessages(messages){
  $('chat-area').innerHTML=messages.length?messages.map(m=>`<article id="msg-${m.id}" class="message-row ${m.speaker==='self'?'self':''}"><div class="avatar message-avatar">${m.speaker==='self'?'我':esc(avatar(state.detail.customer.name))}</div><div class="message-body"><div class="message-meta"><span>${m.speaker==='self'?'我的消息':'客户'}</span><span>${esc(m.visible_time||'截图未显示时间')}</span>${m.uncertain?'<span class="warning-tag">需留意识别</span>':''}</div><div class="bubble"><p class="original" dir="auto">${esc(m.original)}</p><div class="translation"><span>中文理解</span>${esc(m.chinese)}</div></div><div class="message-tools"><button class="text-button" data-copy-message="${m.id}">复制原文</button><button class="text-button" data-edit-message="${m.id}">校对</button><button class="text-button" data-delete-message="${m.id}">删除</button>${m.screenshots.map((s,i)=>`<button class="text-button" data-image="${s.id}">截图${i+1}</button>`).join('')}</div></div></article>`).join(''):'<div class="empty-list">这位客户还没有聊天记录。<br>上传截图或粘贴原话，开始第一轮分析。</div>';
  document.querySelectorAll('[data-copy-message]').forEach(b=>b.onclick=()=>copy(messages.find(m=>m.id===b.dataset.copyMessage).original));
  document.querySelectorAll('[data-edit-message]').forEach(b=>b.onclick=()=>editMessage(messages.find(m=>m.id===b.dataset.editMessage)));
  document.querySelectorAll('[data-delete-message]').forEach(b=>b.onclick=()=>deleteMessage(messages.find(m=>m.id===b.dataset.deleteMessage)));
  document.querySelectorAll('[data-image]').forEach(b=>b.onclick=()=>showSmall('原始截图',`<img src="/api/screenshots/${b.dataset.image}" alt="原始聊天截图">`));
  $('chat-area').scrollTop=$('chat-area').scrollHeight;
}
function memorySectionHtml(section){
  const rows=(section.items||[]).map(item=>`<article class="bilingual-memory" data-memory-fact="${item.fact_id}"><div class="bilingual-memory-label">${esc(item.label)}${item.certainty==='inferred'?'<span class="warning-tag">AI推测</span>':''}</div><p class="memory-original-caption">${esc(item.original_label||'资料原文')}</p><p class="memory-original" dir="auto">${esc(item.original)}</p><div class="memory-chinese" dir="ltr"><span class="memory-chinese-label">${item.original_label==='来源消息原文'?'中文记忆要点':'中文解释'}</span><p data-memory-chinese="${item.fact_id}">${esc(item.chinese||'正在补充中文解释…')}</p></div><button class="fact-source" data-source="${item.fact_id}">查看消息来源 ↗</button></article>`).join('');
  return `<div class="memory-overview-group"><h4>${esc(section.title)}${section.status?`<span>${esc(section.status)}</span>`:''}</h4>${rows||`<p>${esc(section.text)}</p>`}${section.items?.length&&section.note?`<p class="memory-meta">${esc(section.note)}</p>`:''}</div>`;
}
const memoryJobs=new Set();
async function loadMemoryChinese(detail){
  if(!detail?.memory)return;
  const id=detail.customer.id,revision=detail.memory.revision,job=id+':'+revision;
  const pending=detail.memory.sections.flatMap(section=>section.items||[]).filter(item=>!item.chinese);
  const current=()=>state.selected===id&&state.detail?.memory?.revision===revision;
  if(!pending.length||memoryJobs.has(job))return;
  if(!state.status.qwen_configured){if(current()&&$('memory-translation-status'))$('memory-translation-status').textContent='配置千问后可补充旧外文记忆的中文解释。';return;}
  memoryJobs.add(job);
  if(current()&&$('memory-translation-status'))$('memory-translation-status').textContent='正在整理中文对照，原记录保持不变…';
  if(current()&&$('retry-memory-translation'))$('retry-memory-translation').hidden=true;
  try{
    for(let offset=0;offset<pending.length;offset+=10){
      const result=await post(`/api/customers/${id}/memory/translate`,{revision,fact_ids:pending.slice(offset,offset+10).map(item=>item.fact_id)});
      if(!current())return;
      for(const translation of result.translations){
        const item=state.detail.memory.sections.flatMap(section=>section.items||[]).find(item=>item.fact_id===translation.fact_id);
        if(!item)continue;item.chinese=translation.chinese;
        document.querySelectorAll(`[data-memory-chinese="${translation.fact_id}"]`).forEach(element=>{element.textContent=translation.chinese;});
      }
    }
    if(current()&&$('memory-translation-status'))$('memory-translation-status').textContent='';
  }catch(error){if(current()&&$('memory-translation-status')){$('memory-translation-status').textContent=error.message;$('retry-memory-translation').hidden=false;}}
  finally{memoryJobs.delete(job);}
}
function renderProfile(customer,facts,latest){
  const detail=state.detail,allFacts=detail.facts,active=allFacts.filter(f=>f.state==='active'),old=allFacts.filter(f=>f.state!=='active');
  const memory=detail.memory;
  const factHtml=f=>`<div class="fact ${f.certainty==='inferred'?'inferred':''} ${f.state}"><div class="fact-label"><span>${esc(labels[f.field])}${f.shipment_id?' · '+esc(detail.shipments.find(s=>s.id===f.shipment_id)?.title||'运输需求'):''}</span><span>${f.state==='superseded'?'已被更新':f.state==='needs_review'?'原消息变更 · 待复核':f.certainty==='inferred'?'AI推测':'客户明确陈述'}</span></div><div class="fact-value">${esc(f.value)}</div><button class="fact-source" data-source="${f.id}">查看消息来源 ↗</button></div>`;
  const pending=state.draft?.customer_id===customer.id&&(state.draft.shipment_id||null)===state.shipment?state.draft:null;
  const batch=pending?{...pending.analysis,screenshots:pending.screenshots,demo:pending.demo,created_at:pending.created_at}:latest;
  const imageCount=batch?.screenshots?.length||0;
  $('profile-content').innerHTML=`<section class="memory-overview" aria-label="全部记录的记忆总结"><div class="memory-section-head"><h3>全部记录的记忆总结</h3><span class="small-badge">自动汇总</span></div><p class="memory-meta">${esc(memory?.introduction||'尚无已归档记忆')}</p>${memory?.sections.length?memory.sections.map(memorySectionHtml).join(''):'<p class="memory-empty">确认并归档聊天后，这里会汇总该客户的全部有效记忆。</p>'}${memory?.needs_review_count?`<p class="warning-tag memory-meta">${memory.needs_review_count} 项记忆的来源有变更，已从当前总结排除，等待复核。</p>`:''}<p id="memory-translation-status" class="memory-meta" role="status" aria-live="polite"></p><button type="button" id="retry-memory-translation" class="text-button" hidden>重试中文解释</button><details class="memory-sources"><summary>查看记忆来源 · ${active.length} 项</summary>${active.map(factHtml).join('')||'<p class="memory-empty">暂无有效记忆</p>'}</details></section><section class="latest-summary" aria-label="本次聊天图片总结"><div class="memory-section-head"><h3>本次聊天图片总结</h3></div>${batch?`<p class="memory-meta">${pending?'待确认 · 尚未写入客户记忆':'最近一次已归档'} · ${imageCount?imageCount+' 张图片':'文本聊天'}${batch.demo?' · 固定演示':''}</p>${batch.stale?'<p class="warning-tag">消息、报价或运输需求有变更，本次旧总结已停用，请重新分析。</p>':`<p class="batch-summary-text">${esc(batch.summary||'本次没有可用的沟通总结。')}</p>`}`:'<p class="memory-empty">分析当前客户的聊天截图后，这里显示本次总结；上方保留全部已归档记忆。</p>'}</section><details class="memory-tools"><summary>客户资料、运输需求与历史记忆</summary><div class="profile-details"><p><span>联系信息</span><strong>${esc(customer.phone||'未记录')}</strong></p><p><span>归档消息</span><strong>${memory?.message_count||0} 条</strong></p><p><span>客户状态</span><strong>${esc(customer.status)}</strong></p></div><div id="shipment-profile"></div>${old.length?`<details><summary class="section-label">历史与待复核 · ${old.length} 项</summary>${old.map(factHtml).join('')}</details>`:''}<div class="section-label">数据留档</div><button id="export-customer" class="button quiet full">导出客户文字档案 ↓</button></details>`;
  $('retry-memory-translation').onclick=()=>loadMemoryChinese(state.detail);
  document.querySelectorAll('[data-source]').forEach(b=>b.onclick=()=>{const f=allFacts.find(f=>f.id===b.dataset.source);showSmall('记忆来源',`<p>${esc(labels[f.field])}：${esc(f.value)}</p><div class="source-quote" dir="auto">${esc(f.evidence)}</div><p class="translation">${esc(f.evidence_chinese)}</p><p>${esc(f.evidence_time||'原截图无可见时间')}</p>`);});
  $('export-customer').onclick=()=>{const a=document.createElement('a');a.href=`/api/customers/${customer.id}/export`;a.download='customer-export.json';a.click();};
  const shipment=detail.shipments.find(s=>s.id===state.shipment),quotes=detail.quotes.filter(q=>q.shipment_id===state.shipment);
  const business=$('shipment-profile');business.className='shipment-profile';
  business.innerHTML=shipment?`<div class="section-label"><span>这票运输需求</span><button id="edit-shipment" class="text-button">编辑</button></div><h3>${esc(shipment.title)}</h3><p>${esc(shipment.status)}</p>${shipment.notes?`<p>${esc(shipment.notes)}</p>`:''}<div class="section-label"><span>报价记录 · ${quotes.length}</span><button id="new-quote" class="text-button">＋ 记录报价</button></div><p class="identity-hint">手动录入实际报价；新记录保留旧金额。</p>${quotes.map(q=>`<div class="quote-card"><strong>${esc(q.amount)} ${esc(q.currency)}</strong><span class="small-badge">${esc(q.status)}</span><p>${esc(q.scope)}</p><p>有效期：${esc(q.valid_until||'未注明')}</p>${q.notes?`<p>${esc(q.notes)}</p>`:''}<small>${q.state==='needs_review'?'来源已校对或删除 · 待复核':q.evidence_message_id?'有消息来源':'人工录入 · 未关联消息'}</small>${q.evidence_message_id?`<button class="fact-source" data-quote-source="${q.id}">查看来源 ↗</button>`:''}</div>`).join('')}`:`<div class="section-label">运输需求 · ${detail.shipments.length} 票</div><p class="identity-hint">每票货物分别归档，避免新旧货量混淆。</p><button id="profile-new-shipment" class="button quiet full">＋ 新建运输需求</button>`;
  if(shipment){$('edit-shipment').onclick=()=>shipmentForm(shipment);$('new-quote').onclick=quoteForm;}
  else $('profile-new-shipment').onclick=()=>shipmentForm();
  document.querySelectorAll('[data-quote-source]').forEach(b=>b.onclick=()=>{const q=quotes.find(q=>q.id===b.dataset.quoteSource),m=detail.messages.find(m=>m.id===q.evidence_message_id);showSmall('报价来源',m?`<div class="source-quote" dir="auto">${esc(m.original)}</div><p>${esc(m.chinese)}</p>`:'来源消息已删除，请复核报价。');});
}
function shipmentForm(shipment=null){
  const customerId=state.selected;if(!customerId)return toast('请先选择客户',true);
  showSmall(shipment?'编辑运输需求':'新建运输需求',`<form id="shipment-form"><label>这票货物的名称<input name="title" maxlength="120" value="${esc(shipment?.title||'')}" placeholder="例如：家具 · 义乌到卡萨布兰卡" required></label><label>状态<select name="status">${shipmentStatuses.map(s=>`<option ${s===shipment?.status?'selected':''}>${s}</option>`).join('')}</select></label><label>人工备注<textarea name="notes" maxlength="2000" rows="3">${esc(shipment?.notes||'')}</textarea></label><p>每票货物拥有独立消息、事实和报价。既有未分类记录不会自动迁入。</p><div class="buttons"><button class="button primary">保存运输需求</button></div></form>`);
  $('shipment-form').onsubmit=async e=>{e.preventDefault();const b=Object.fromEntries(new FormData(e.target));try{const path=`/api/customers/${customerId}/shipments`;const s=shipment?await api(`${path}/${shipment.id}`,{method:'PATCH',body:JSON.stringify(b)}):await post(path,b);$('small-dialog').close();await selectCustomer(customerId,s.id);await refreshCustomers();}catch(e){toast(e.message,true);}};
}
function quoteForm(){
  const customerId=state.selected,shipmentId=state.shipment;
  const messages=scopedMessages(state.detail.messages);
  showSmall('记录实际报价',`<form id="quote-form"><div class="review-grid"><label>金额<input name="amount" inputmode="decimal" placeholder="例如：1250.00" maxlength="20" required></label><label>币种<select name="currency">${['USD','CNY','EUR','MAD','AED','GBP'].map(c=>`<option>${c}</option>`).join('')}</select></label></div><label>包含及不包含的范围<textarea name="scope" rows="3" maxlength="2000" placeholder="例如：海运至港；不含清关、税费和派送" required></textarea></label><label>有效期（可留空）<input type="date" name="valid_until"></label><label>状态<select name="status">${quoteStatuses.map(s=>`<option>${s}</option>`).join('')}</select></label><label>消息来源<select name="evidence_message_id"><option value="">人工录入，未关联消息</option>${messages.map(m=>`<option value="${m.id}">${esc(m.chinese.slice(0,90))}</option>`).join('')}</select></label><label>备注<textarea name="notes" rows="2" maxlength="2000"></textarea></label><p>只记录你已核对的报价；不会计算运价或自动发送。金额和币种保存后不覆盖，修订时新增一条。</p><div class="buttons"><button class="button primary">保存报价记录</button></div></form>`);
  $('quote-form').onsubmit=async e=>{e.preventDefault();try{await post(`/api/customers/${customerId}/shipments/${shipmentId}/quotes`,Object.fromEntries(new FormData(e.target)));$('small-dialog').close();await selectCustomer(customerId,shipmentId);toast('报价已记录');}catch(e){toast(e.message,true);}};
}
$('shipment-select').onchange=()=>selectCustomer(state.selected,$('shipment-select').value||null);
$('new-shipment').onclick=()=>shipmentForm();
const referenceCategories=['公司介绍','佣金/费率','服务说明','常见问题','其他资料'];
let referenceQuery='';
async function refreshSelectedReferences(){
  const id=state.selected,shipment=state.shipment;if(!id)return;
  const detail=await api(`/api/customers/${id}?shipment_id=${encodeURIComponent(shipment||'')}`);
  if(state.selected!==id||state.shipment!==shipment)return;
  state.detail.latest=detail.latest;renderReplies(detail.latest);
}
async function referenceLibrary(){
  try{
    const {entries}=await api('/api/references');
    showSmall('数据库参考 · 所有聊天共用',`<p>添加公司介绍、类目佣金、服务范围等资料。AI 自动回复会读取相关的已启用资料；自定义回复仍忠实翻译你的输入。</p><div class="reference-toolbar"><input id="reference-search" aria-label="搜索公共资料" placeholder="搜索标题、类目或关键词" value="${esc(referenceQuery)}"><button id="reference-add" class="button primary">＋ 新增资料</button></div><div id="reference-list"></div>`);
    $('small-dialog').classList.add('library-dialog');
    function list(){
      const query=$('reference-search').value.trim().toLowerCase();referenceQuery=query;
      const visible=entries.filter(entry=>[entry.title,entry.category,entry.content,entry.scope,entry.keywords].join(' ').toLowerCase().includes(query));
      $('reference-list').innerHTML=visible.length?visible.map(entry=>`<article class="reference-card"><div class="reference-card-title"><strong>${esc(entry.title)}</strong><span class="small-badge">${esc(entry.category)}</span></div><p class="reference-state">${!entry.enabled?'已停用':!entry.available?'已过有效期':'已启用'} · ${entry.usage==='internal'?'内部查阅，不用于AI回复':'所有聊天的回复参考'}${entry.valid_until?' · 有效至 '+esc(entry.valid_until):''}</p>${entry.scope?`<p><b>适用条件：</b>${esc(entry.scope)}</p>`:''}<p class="reference-preview" dir="auto">${esc(entry.content.slice(0,240))}${entry.content.length>240?'…':''}</p><div class="reference-card-actions"><button class="button quiet" data-reference-view="${entry.id}">查看</button><button class="button quiet" data-reference-edit="${entry.id}">编辑</button><button class="button danger" data-reference-delete="${entry.id}">删除</button></div></article>`).join(''):'<p class="memory-empty">没有匹配的资料。点击“新增资料”开始建立公共资料库。</p>';
      document.querySelectorAll('[data-reference-view]').forEach(button=>button.onclick=()=>referenceView(button.dataset.referenceView));
      document.querySelectorAll('[data-reference-edit]').forEach(button=>button.onclick=()=>referenceForm(entries.find(entry=>entry.id===button.dataset.referenceEdit)));
      document.querySelectorAll('[data-reference-delete]').forEach(button=>button.onclick=()=>referenceDelete(entries.find(entry=>entry.id===button.dataset.referenceDelete)));
    }
    $('reference-search').oninput=list;$('reference-add').onclick=()=>referenceForm();list();
  }catch(error){toast(error.message,true);}
}
function referenceForm(entry=null){
  showSmall(entry?'编辑公共资料':'新增公共资料',`<form id="reference-form"><label>资料标题<input name="title" maxlength="160" value="${esc(entry?.title||'')}" placeholder="例如：公司服务介绍、家具类佣金规则" required></label><label>资料分类<select name="category" id="reference-category">${referenceCategories.map(category=>`<option ${category===(entry?.category||'公司介绍')?'selected':''}>${esc(category)}</option>`).join('')}</select></label><label>资料内容<textarea name="content" rows="7" maxlength="12000" placeholder="填写你们核对过的介绍、费率和业务说明；AI 会保留所写条件。" required>${esc(entry?.content||'')}</textarea></label><label>适用类目与条件（佣金/费率必填）<textarea name="scope" id="reference-scope" rows="2" maxlength="1500" placeholder="适用货物、计算基数、币种、包含及不包含的费用等">${esc(entry?.scope||'')}</textarea></label><label>匹配关键词（可留空）<input name="keywords" maxlength="600" value="${esc(entry?.keywords||'')}" placeholder="可填中文、英文或法语关键词，用逗号分隔"></label><div class="review-grid"><label>有效期（可留空）<input name="valid_until" type="date" value="${esc(entry?.valid_until||'')}"></label><label>资料用途<select name="usage"><option value="reply" ${entry?.usage!=='internal'?'selected':''}>用于客户回复参考</option><option value="internal" ${entry?.usage==='internal'?'selected':''}>内部查阅，不发送给AI</option></select></label></div><label class="reference-check"><input type="checkbox" name="enabled" ${entry?.enabled===false?'':'checked'}>启用这条资料</label><p id="reference-form-error" class="error-text" role="status"></p><div class="buttons"><button type="button" id="reference-back" class="button quiet">返回资料库</button><button id="reference-save" class="button primary">保存资料</button></div></form>`);
  $('small-dialog').classList.add('library-dialog');
  $('reference-back').onclick=referenceLibrary;
  $('reference-category').onchange=()=>{$('reference-scope').required=$('reference-category').value==='佣金/费率';};$('reference-category').onchange();
  $('reference-form').onsubmit=async event=>{
    event.preventDefault();const value=Object.fromEntries(new FormData(event.target));value.enabled=event.target.elements.enabled.checked;
    $('reference-save').disabled=true;
    try{if(entry)await api(`/api/references/${entry.id}`,{method:'PATCH',body:JSON.stringify(value)});else await post('/api/references',value);await refreshSelectedReferences();await referenceLibrary();toast('资料已保存，所有聊天均可参考');}
    catch(error){if($('reference-form-error'))$('reference-form-error').textContent=error.message;}
    finally{if($('reference-save'))$('reference-save').disabled=false;}
  };
}
async function referenceView(id){
  try{
    const entry=await api(`/api/references/${id}`);
    showSmall(entry.title,`<p>${esc(entry.category)} · ${entry.available?'已启用且在有效期内':'已停用或过期'} · ${entry.usage==='reply'?'用于回复参考':'仅内部查阅'}</p>${entry.scope?`<p><b>适用条件：</b>${esc(entry.scope)}</p>`:''}${entry.valid_until?`<p>有效至 ${esc(entry.valid_until)}</p>`:''}<div class="source-quote" dir="auto">${esc(entry.content)}</div><div class="buttons"><button id="reference-back" class="button quiet">返回资料库</button><button id="reference-edit-current" class="button primary">编辑资料</button></div>`);
    $('small-dialog').classList.add('library-dialog');$('reference-back').onclick=referenceLibrary;$('reference-edit-current').onclick=()=>referenceForm(entry);
  }catch(error){toast(error.message,true);}
}
function referenceDelete(entry){
  showSmall('删除公共资料',`<p>删除“${esc(entry.title)}”后，所有聊天的后续回复都不再参考它。受资料变更影响的旧回复需重新生成。</p><div class="buttons"><button id="reference-back" class="button quiet">保留资料</button><button id="reference-confirm-delete" class="button danger">删除资料</button></div>`);
  $('reference-back').onclick=referenceLibrary;$('reference-confirm-delete').onclick=async()=>{try{await api(`/api/references/${entry.id}`,{method:'DELETE'});await refreshSelectedReferences();await referenceLibrary();toast('资料已删除');}catch(error){toast(error.message,true);}};
}
const referenceRefreshes=new Set();
function bindReferenceRefresh(){
  const button=$('refresh-reference-replies');if(!button)return;
  const id=state.selected,shipment=state.shipment,scope=replyScope(),draftId=state.detail?.latest?.id;
  button.disabled=referenceRefreshes.has(scope);button.textContent=button.disabled?'正在更新…':'按资料库更新回复';
  button.onclick=async()=>{
    if(!state.status.qwen_configured){settings();return;}
    referenceRefreshes.add(scope);button.disabled=true;button.textContent='正在更新…';
    try{
      const latest=await post(`/api/customers/${id}/replies/refresh`,{shipment_id:shipment,draft_id:draftId});
      if(state.selected===id&&state.shipment===shipment&&state.detail?.latest?.id===draftId){state.detail.latest=latest;renderReplies(latest);toast('已按当前资料库更新回复');}
    }catch(error){toast(error.message,true);}
    finally{referenceRefreshes.delete(scope);if(state.selected===id&&state.shipment===shipment)renderReplies(state.detail?.latest);}
  };
}

const replyLanguages=[['en','英语'],['fr','法语'],['ar','阿拉伯语'],['darija','摩洛哥达里贾'],['es','西班牙语']];
const customReplies=new Map();
let repliesCollapsed=false;
const replyScope=()=>`${state.selected||'new'}:${state.shipment||'general'}`;
function customReplyState(){const key=replyScope();if(!customReplies.has(key))customReplies.set(key,{text:'',languages:['en'],translations:[],busy:false,error:''});return customReplies.get(key);}
function renderReplies(latest){
  const replies=latest?.replies||[],custom=state.replyStyle==='custom'||!replies.length;
  $('replies').hidden=false;
  const reply=replies.find(r=>r.style===state.replyStyle)||replies[0];
  const tabs=`${replies.map(r=>`<button data-reply="${r.style}" class="${!custom&&reply.style===r.style?'active':''}">${styles[r.style]}</button>`).join('')}<button data-reply="custom" class="${custom?'active':''}">自定义回复</button>`;
  $('replies').innerHTML=`<div class="reply-head"><div class="reply-heading"><h3>AI 回复参考 ${latest?.demo?'· 固定演示':''}</h3><button type="button" id="reference-library-btn" class="button quiet reference-library-button">数据库参考</button></div><div class="reply-tabs">${tabs}<button type="button" id="toggle-replies" class="reply-collapse" aria-controls="reply-content"></button></div></div><div id="reply-content"></div>`;
  $('reference-library-btn').onclick=referenceLibrary;
  function applyCollapse(){
    $('reply-content').hidden=repliesCollapsed;$('replies').classList.toggle('is-collapsed',repliesCollapsed);
    const button=$('toggle-replies'),label=repliesCollapsed?'展开 AI 回复参考':'收起 AI 回复参考';
    button.textContent=repliesCollapsed?'⌄':'⌃';button.title=label;button.setAttribute('aria-label',label);button.setAttribute('aria-expanded',String(!repliesCollapsed));
  }
  $('toggle-replies').onclick=()=>{repliesCollapsed=!repliesCollapsed;applyCollapse();};applyCollapse();
  document.querySelectorAll('[data-reply]').forEach(b=>b.onclick=()=>{state.replyStyle=b.dataset.reply;repliesCollapsed=false;renderReplies(latest);});
  if(!custom){
    if(latest.stale){$('reply-content').innerHTML='<div class="warning-box">消息、报价或运输需求有变更，旧回复已停用。请重新分析，或使用自定义回复翻译你要表达的内容。</div>';return;}
    if(latest.references_stale){$('reply-content').innerHTML='<div class="warning-box">公共资料库已更新或资料有效期有变化，旧自动回复已停用，请按当前资料重新生成。</div><button type="button" id="refresh-reference-replies" class="button quiet">按资料库更新回复</button>';bindReferenceRefresh();return;}
    $('reply-content').innerHTML=`<p class="reply-text" dir="auto">${esc(reply.text)}</p><p class="reply-zh">${esc(reply.chinese)}</p><div class="reply-copy"><span>需你确认 · 复制不会自动发送</span><div class="reply-copy-buttons"><button type="button" id="refresh-reference-replies" class="button quiet">按资料库更新回复</button><button id="copy-reply" class="button">复制回复</button></div></div><div id="reply-reference-sources" class="reply-reference-sources"></div>`;
    $('copy-reply').onclick=()=>copy(reply.text);bindReferenceRefresh();
    const sources=(latest.reference_sources||[]).filter(source=>(reply.reference_ids||[]).includes(source.id));
    $('reply-reference-sources').innerHTML=sources.length?'参考资料：'+sources.map(source=>`<button type="button" class="text-button" data-reply-reference="${source.id}">${esc(source.title)}</button>`).join(' · '):'';
    document.querySelectorAll('[data-reply-reference]').forEach(button=>button.onclick=()=>referenceView(button.dataset.replyReference));return;
  }
  const entry=customReplyState(),scope=replyScope();
  $('reply-content').innerHTML=`<form id="custom-reply-form"><label for="custom-reply-text" class="custom-reply-label">输入你想回复的中文</label><textarea id="custom-reply-text" rows="2" maxlength="6000" placeholder="例如：请确认包装后的总体积和重量，我再为你核算运费。" required>${esc(entry.text)}</textarea><fieldset class="translation-languages"><legend>翻译成（可多选）</legend>${replyLanguages.map(([code,name])=>`<label><input type="checkbox" name="language" value="${code}" ${entry.languages.includes(code)?'checked':''}>${name}</label>`).join('')}</fieldset><div class="custom-reply-actions"><span>忠实翻译你的原话 · 不会自动发送</span><button id="translate-custom-reply" class="button primary" ${entry.busy?'disabled':''}>${entry.busy?'正在翻译…':'翻译回复'}</button></div><p id="custom-reply-error" class="error-text" role="status">${esc(entry.error)}</p><div id="custom-reply-results"></div></form>`;
  function renderResults(){
    $('custom-reply-results').innerHTML=entry.translations.map(item=>`<article class="custom-translation"><div><strong>${esc(item.label)}</strong><button type="button" data-copy-translation="${item.language}" class="button quiet">复制</button></div><p class="reply-text" dir="auto">${esc(item.text)}</p></article>`).join('');
    document.querySelectorAll('[data-copy-translation]').forEach(button=>button.onclick=()=>copy(entry.translations.find(item=>item.language===button.dataset.copyTranslation).text));
  }
  renderResults();
  function invalidate(){entry.translations=[];entry.error='';$('custom-reply-results').innerHTML='';$('custom-reply-error').textContent='';}
  $('custom-reply-text').oninput=()=>{entry.text=$('custom-reply-text').value;invalidate();};
  document.querySelectorAll('input[name="language"]').forEach(input=>input.onchange=()=>{entry.languages=[...document.querySelectorAll('input[name="language"]:checked')].map(input=>input.value);invalidate();});
  $('custom-reply-form').onsubmit=async event=>{
    event.preventDefault();if(entry.busy)return;
    if(!entry.languages.length){entry.error='请至少勾选一种目标语言。';$('custom-reply-error').textContent=entry.error;return;}
    if(!state.status.qwen_configured){settings();return;}
    const input={text:entry.text.trim(),languages:[...entry.languages]},signature=JSON.stringify(input);
    entry.busy=true;entry.error='';entry.translations=[];renderReplies(latest);
    try{
      const result=await post('/api/replies/translate',input);
      if(JSON.stringify({text:entry.text.trim(),languages:entry.languages})===signature)entry.translations=result.translations;
      else entry.error='内容或目标语言已改变，请重新翻译。';
    }catch(error){entry.error=error.message;}
    finally{entry.busy=false;if(replyScope()===scope&&(state.replyStyle==='custom'||!(state.detail?.latest?.replies?.length)))renderReplies(state.detail?.latest);}
  };
}
async function copy(text){try{await navigator.clipboard.writeText(text);toast('已复制');}catch{showSmall('请手动复制',`<textarea id="copy-fallback" rows="8" readonly>${esc(text)}</textarea>`);$('copy-fallback').select();}}
function showSmall(title,html){$('small-dialog').classList.remove('library-dialog');$('small-title').textContent=title;$('small-body').innerHTML=html;if(!$('small-dialog').open)$('small-dialog').showModal();}
$('small-close').onclick=()=>$('small-dialog').close();
function customerForm(edit=false){
  const c=edit?state.detail.customer:{};
  showSmall(edit?'编辑客户':'新建客户',`<form id="customer-form"><label>客户姓名<input name="name" maxlength="120" value="${esc(c.name||'')}" required></label><label>电话 / 联系标识<input name="phone" maxlength="80" value="${esc(c.phone||'')}" placeholder="可以先留空"></label><label>所在城市<input name="city" maxlength="100" value="${esc(c.city||'')}"></label><label>沟通语言<input name="preferred_language" maxlength="80" value="${esc(c.preferred_language||'')}" placeholder="法语 / Darija / 英语"></label>${edit?`<label>跟进状态<select name="status">${['新询盘','等待资料','待报价','等待确认','已成交','跟进中'].map(v=>`<option ${v===c.status?'selected':''}>${v}</option>`).join('')}</select></label>`:''}<p>即使姓名相同，也不会自动合并为同一个客户。</p><div class="buttons"><button class="button primary">${edit?'保存':'建立档案'}</button></div></form>`);
  $('customer-form').onsubmit=async e=>{e.preventDefault();const b=Object.fromEntries(new FormData(e.target));try{const result=edit?await api(`/api/customers/${c.id}`,{method:'PATCH',body:JSON.stringify(b)}):await post('/api/customers',b);$('small-dialog').close();await refreshCustomers();await selectCustomer(result.id);}catch(e){toast(e.message,true);}};
}
$('new-customer').onclick=()=>customerForm();$('edit-customer').onclick=()=>customerForm(true);
$('customer-search').oninput=()=>{clearTimeout(customerSearchTimer);customerSearchTimer=setTimeout(renderCustomers,100);};
$('chat-search').oninput=()=>{clearTimeout(chatSearchTimer);chatSearchTimer=setTimeout(async()=>{const id=state.selected,shipment=state.shipment,query=$('chat-search').value;try{const d=await api(`/api/customers/${id}?q=${encodeURIComponent(query)}&shipment_id=${encodeURIComponent(shipment||'')}`);if(state.selected===id && state.shipment===shipment && $('chat-search').value===query)renderMessages(scopedMessages(d.messages));}catch(e){toast(e.message,true);}},220);};
function editMessage(m){
  showSmall('校对已归档消息',`<form id="edit-message-form"><label>发送方<select name="speaker"><option value="customer" ${m.speaker==='customer'?'selected':''}>客户</option><option value="self" ${m.speaker==='self'?'selected':''}>我</option></select></label><label>原文<textarea name="original" dir="auto" rows="4" required>${esc(m.original)}</textarea></label><label>中文<textarea name="chinese" rows="4" required>${esc(m.chinese)}</textarea></label><p>修改后，这条消息的关联记忆将标记为待复核，旧回复建议会停用。</p><div class="buttons"><button class="button primary">保存校对</button></div></form>`);
  $('edit-message-form').onsubmit=async e=>{e.preventDefault();const id=state.selected;const data={...m,...Object.fromEntries(new FormData(e.target))};try{await api(`/api/customers/${id}/messages/${m.id}`,{method:'PATCH',body:JSON.stringify(data)});$('small-dialog').close();await reloadDetail();toast('已保存校对，相关记忆需重新核对');}catch(e){toast(e.message,true);}};
}
function deleteMessage(m){
  showSmall('删除这条消息',`<p>将删除消息及以它为来源的客户事实，旧回复也会停用。</p><div class="source-quote">${esc(m.chinese)}</div><div class="buttons"><button id="cancel-delete" class="button">取消</button><button id="confirm-delete" class="button danger">确认删除</button></div>`);
  $('cancel-delete').onclick=()=>$('small-dialog').close();
  $('confirm-delete').onclick=async()=>{try{await api(`/api/customers/${state.selected}/messages/${m.id}`,{method:'DELETE'});$('small-dialog').close();await reloadDetail();toast('消息已删除');}catch(e){toast(e.message,true);}};
}
function addFiles(files){
  const allowed=['image/png','image/jpeg','image/webp'];
  for(const file of files){
    if(!allowed.includes(file.type)){toast('只支持 PNG、JPEG、WebP 截图',true);continue;}
    if(file.size>8*1024**2 || state.files.reduce((s,x)=>s+x.file.size,0)+file.size>32*1024**2){toast('单张8MB、合计32MB以内',true);continue;}
    if(state.files.length>=5){toast('一次最多5张截图',true);break;}
    state.files.push({file,url:URL.createObjectURL(file)});
  }
  renderFiles();
}
function renderFiles(){
  $('image-list').innerHTML=state.files.map((x,i)=>`<div class="image-thumb"><img src="${esc(x.url)}" alt="${esc(x.file.name)}"><button data-remove="${i}" aria-label="移除截图${i+1}">×</button></div>`).join('');
  document.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{const [x]=state.files.splice(Number(b.dataset.remove),1);URL.revokeObjectURL(x.url);renderFiles();});
}
$('file-input').onchange=e=>{addFiles(e.target.files);e.target.value='';};
$('drop-zone').ondragover=e=>{e.preventDefault();$('drop-zone').classList.add('dragging');};
$('drop-zone').ondragleave=()=>$('drop-zone').classList.remove('dragging');
$('drop-zone').ondrop=e=>{e.preventDefault();$('drop-zone').classList.remove('dragging');addFiles(e.dataTransfer.files);};
document.addEventListener('paste',e=>{if(document.querySelector('dialog[open]'))return;const files=[...(e.clipboardData?.items||[])].filter(x=>x.kind==='file').map(x=>x.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();addFiles(files);setPanel('chat');}});
const fileData=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:reader.result});reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file);});
function busy(value){state.busy=value;$('analyze-btn').disabled=value;$('analyze-btn').textContent=value?'千问正在读取…':'分析并翻译 ↗';}
$('analyze-btn').onclick=async()=>{
  if(state.busy)return;const text=$('message-input').value.trim();if(!text && !state.files.length)return toast('先上传截图或输入原文',true);
  if(!state.status.qwen_configured){settings();return;}
  const customer_id=state.selected,shipment_id=state.shipment;busy(true);
  try{const images=await Promise.all(state.files.map(x=>fileData(x.file)));const draft=await post('/api/analyze',{text,images,customer_id,shipment_id});openReview(draft);await refreshDrafts();}
  catch(e){toast(e.message,true);}finally{busy(false);}
};
async function demo(){try{const d=await post('/api/demo',{});openReview(d);await refreshDrafts();}catch(e){toast(e.message,true);}}
$('demo-btn').onclick=demo;
function openReview(draft){
  state.draft=draft;
  if(state.detail&&draft.customer_id===state.selected)renderProfile(state.detail.customer,state.detail.facts,state.detail.latest);
  const a=draft.analysis;
  const options=draft.demo?`<option value="new">新建演示客户</option>`:draft.customer_id?`<option value="${draft.customer_id}">${esc(state.customers.find(c=>c.id===draft.customer_id)?.name||'当前客户')}</option>`:`<option value="">请确认这是谁的聊天</option><option value="new">新建客户档案</option>${state.customers.map(c=>`<option value="${c.id}">${esc(c.name)} ${esc(c.phone)}</option>`).join('')}`;
  $('review-body').innerHTML=`${a.warnings.length?`<div class="warning-box">${a.warnings.map(esc).join('<br>')}</div>`:''}<section class="review-step"><h3>01 · 确认客户</h3><p class="identity-hint">${a.identity.name||a.identity.phone?`图片身份线索：${esc(a.identity.name)} ${esc(a.identity.phone)}。仅供参考，请自行核对。`:'没有足够的客户身份线索，请确认归属。'}${draft.customer_id?' 本次分析已使用所选客户记忆，如归属错误请关闭并重新分析。':''}</p><select id="review-target" required>${options}</select><div id="new-target-fields" ${draft.demo?'':'hidden'}><label>新客户姓名<input id="review-new-name" maxlength="120" value="${esc(a.identity.name||'')}" placeholder="请输入可辨识的客户姓名"></label><label>电话 / 联系标识<input id="review-new-phone" maxlength="80" value="${esc(a.identity.phone||'')}"></label></div></section><section class="review-step"><h3>02 · 校对原文与中文</h3>${a.messages.map((m,i)=>`<div class="review-message" data-review-index="${i}"><div class="review-message-head"><b>消息 ${i+1}</b><select data-m-speaker="${i}" aria-label="消息${i+1}发送方"><option value="customer" ${m.speaker==='customer'?'selected':''}>客户</option><option value="self" ${m.speaker==='self'?'selected':''}>我</option><option value="unknown" ${m.speaker==='unknown'?'selected':''}>需确认</option></select><input data-m-time="${i}" value="${esc(m.visible_time)}" placeholder="截图可见时间" aria-label="消息${i+1}时间"><label><input type="checkbox" data-m-uncertain="${i}" ${m.uncertain?'checked':''}>识别待留意</label></div><div class="review-grid"><label><span>原文 · ${esc(m.language)}</span><textarea data-m-original="${i}" dir="auto" maxlength="6000" required>${esc(m.original)}</textarea></label><label><span>中文理解</span><textarea data-m-chinese="${i}" maxlength="6000" required>${esc(m.chinese)}</textarea></label></div></div>`).join('')}</section><section class="review-step"><h3>03 · 选择写入的客户记忆</h3><p class="identity-hint">客户明确信息默认勾选；AI 推测默认不选。可修改内容，同字段变化保留历史。不同批次货物需谨慎核对。</p>${a.facts.length?a.facts.map((f,i)=>`<label class="fact-review"><input type="checkbox" data-f-check="${i}" ${f.certainty==='stated'?'checked':''}><div><p>${esc(labels[f.field])} · ${f.certainty==='stated'?'客户明确陈述':'AI推测'} · 来源消息${f.message_index+1}</p><input type="text" data-f-value="${i}" maxlength="1500" value="${esc(f.value)}"></div></label>`).join(''):'<p class="identity-hint">本次没有提取到新增事实。</p>'}</section>`;
  $('review-target').insertAdjacentHTML('afterend',`<div class="review-shipment"><label>本批消息与货物事实归属<select id="review-shipment" aria-label="审核运输需求"><option value="">未分类 / 客户一般沟通</option></select></label><label id="review-shipment-title-wrap" hidden>新运输需求名称<input id="review-shipment-title" maxlength="120" placeholder="例如：家具 · 义乌到卡萨布兰卡"></label><p class="identity-hint">联系方式和语言保存在客户层级；货量、货物和运输范围按本次所选需求保存。若一张截图包含多票货物，请分别分析和审核。更改分析时的需求归属后，旧回复停用，需重新分析。</p></div>`);
  $('review-shipment').onchange=()=>{const isNew=$('review-shipment').value==='new';$('review-shipment-title-wrap').hidden=!isNew;$('review-shipment-title').required=isNew;};
  $('review-target').onchange=()=>{$('new-target-fields').hidden=$('review-target').value!=='new';$('review-new-name').required=$('review-target').value==='new';loadReviewShipments(draft);};
  $('review-target').onchange();
  if(!$('review-dialog').open)$('review-dialog').showModal();
}
async function loadReviewShipments(draft){
  const target=$('review-target').value;
  $('commit-btn').disabled=true;
  try{
    const shipments=target && target!=='new'?await api(`/api/customers/${target}/shipments`):[];
    if(state.draft!==draft || $('review-target').value!==target)return;
    const bound=!!draft.shipment_id;
    $('review-shipment').innerHTML=bound?shipments.filter(s=>s.id===draft.shipment_id).map(s=>`<option value="${s.id}">${esc(s.title)}</option>`).join(''):`<option value="">未分类 / 客户一般沟通</option><option value="new">＋ 新建这票运输需求</option>${shipments.map(s=>`<option value="${s.id}">${esc(s.title)}</option>`).join('')}`;
    if(bound && !shipments.some(s=>s.id===draft.shipment_id))throw new Error('草稿绑定的运输需求不可用，请重新分析');
    $('review-shipment').disabled=bound;
    $('review-shipment').onchange();
    $('commit-btn').disabled=false;
  }catch(e){toast(e.message,true);}
}
$('review-close').onclick=()=>$('review-dialog').close();
$('review-dialog').addEventListener('close',()=>{toast('未保存的分析会保留在“待审核草稿”中');});
$('review-form').onsubmit=async e=>{
  e.preventDefault();const d=state.draft,target=$('review-target').value;
  if(!target)return toast('请确认客户归属',true);
  const messages=d.analysis.messages.map((m,i)=>({...m,speaker:document.querySelector(`[data-m-speaker="${i}"]`).value,original:document.querySelector(`[data-m-original="${i}"]`).value,chinese:document.querySelector(`[data-m-chinese="${i}"]`).value,visible_time:document.querySelector(`[data-m-time="${i}"]`).value,uncertain:document.querySelector(`[data-m-uncertain="${i}"]`).checked}));
  if(messages.some(m=>m.speaker==='unknown'))return toast('请确认所有消息的发送方',true);
  const accepted_facts=d.analysis.facts.flatMap((f,i)=>document.querySelector(`[data-f-check="${i}"]`).checked?[{index:i,value:document.querySelector(`[data-f-value="${i}"]`).value}]:[]);
  const b={messages,accepted_facts,customer_id:target==='new'?null:target,new_customer:target==='new'?{name:$('review-new-name').value,phone:$('review-new-phone').value}:null};
  const shipment=$('review-shipment').value;
  b.shipment_id=shipment && shipment!=='new'?shipment:null;
  b.new_shipment=shipment==='new'?{title:$('review-shipment-title').value}:null;
  $('commit-btn').disabled=true;
  try{const result=await post(`/api/drafts/${d.id}/commit`,b);$('review-dialog').close();state.draft=null;state.files.forEach(x=>URL.revokeObjectURL(x.url));state.files=[];renderFiles();$('message-input').value='';await refreshCustomers();await selectCustomer(result.customer_id,result.shipment_id||null);await refreshDrafts();toast(`已归档 ${result.inserted} 条新消息${result.skipped?`，跳过 ${result.skipped} 条重叠消息`:''}`);}
  catch(e){toast(e.message,true);}finally{$('commit-btn').disabled=false;}
};
async function refreshDrafts(){const drafts=await api('/api/drafts');$('draft-count').textContent=drafts.length;if(state.draft&&!drafts.some(d=>d.id===state.draft.id)){state.draft=null;if(state.detail)renderProfile(state.detail.customer,state.detail.facts,state.detail.latest);}return drafts;}
$('recover-btn').onclick=async()=>{try{const drafts=await refreshDrafts();showSmall('待审核草稿',drafts.length?drafts.map(d=>`<div class="draft-item"><p>${d.demo?'固定演示':esc(state.customers.find(c=>c.id===d.customer_id)?.name||'未确认客户')}<br>${new Date(d.created_at).toLocaleString('zh-CN')}</p><div><button class="button" data-open-draft="${d.id}">审核</button> <button class="button danger" data-remove-draft="${d.id}">删除</button></div></div>`).join(''):'<p>没有待审核的草稿。</p>');document.querySelectorAll('[data-open-draft]').forEach(b=>b.onclick=async()=>{try{const d=await api(`/api/drafts/${b.dataset.openDraft}`);$('small-dialog').close();openReview(d);}catch(e){toast(e.message,true);}});document.querySelectorAll('[data-remove-draft]').forEach(b=>b.onclick=async()=>{try{await api(`/api/drafts/${b.dataset.removeDraft}`,{method:'DELETE'});b.closest('.draft-item').remove();await refreshDrafts();toast('草稿及对应截图已删除');}catch(e){toast(e.message,true);}});}catch(e){toast(e.message,true);}};
const qwenRegions = [
  ['北京', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['新加坡', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'],
  ['美国（弗吉尼亚）', 'https://dashscope-us.aliyuncs.com/compatible-mode/v1']
];
function renderModelStatus(){
  $('model-status').textContent=state.status.qwen_configured?'千问接口已配置':'千问接口待配置';
  $('model-status').classList.toggle('connected',state.status.qwen_configured);
}
async function settings(){
  if(!state.status.authenticated){if(!$('login-dialog').open)$('login-dialog').showModal();return;}
  try{
    const current=await api('/api/settings/qwen');
    const base=current.base_url.includes('YOUR_WORKSPACE_ID')?qwenRegions[0][1]:current.base_url;
    const region=qwenRegions.some(([,url])=>url===base)?base:'custom';
    showSmall('千问 API 设置',`<p>填写你的阿里云百炼 API Key，保存后即可分析聊天。密钥仅保存在服务器，不会回显。</p><form id="qwen-form" autocomplete="off"><label>API Key<input id="qwen-key" name="api_key" type="password" autocomplete="new-password" spellcheck="false" maxlength="2048" placeholder="${current.has_key?'已保存；留空沿用原 Key':'粘贴百炼 API Key'}" ${current.has_key?'':'required'}></label><label>API Key 所属地域<select id="qwen-region">${qwenRegions.map(([name,url])=>`<option value="${url}" ${region===url?'selected':''}>${name}</option>`).join('')}<option value="custom" ${region==='custom'?'selected':''}>工作空间专用地址</option></select></label><p class="identity-hint">地域需与创建 API Key 时选择的地域一致。</p><details><summary>模型与接口地址</summary><label>模型 ID<input name="model" value="${esc(current.model)}" maxlength="120" required></label><label id="qwen-url-label" ${region==='custom'?'':'hidden'}>兼容接口地址<input id="qwen-url" type="url" value="${esc(base)}" placeholder="从百炼控制台复制"></label><p class="identity-hint">截图分析需使用支持图片与 JSON 输出、且账号已开通的模型。</p></details><p id="qwen-result" role="status" aria-live="polite"></p><div class="buttons"><button type="button" id="qwen-test" class="button quiet">测试连接</button><button id="qwen-save" class="button primary">保存设置</button></div><p class="identity-hint">测试会发送一条简短法语文本，产生少量模型调用用量；不会写入客户档案。</p></form>`);
    const form=$('qwen-form');
    $('qwen-region').onchange=()=>{$('qwen-url-label').hidden=$('qwen-region').value!=='custom';};
    async function submit(test){
      if(!form.reportValidity())return;
      const value=Object.fromEntries(new FormData(form));
      value.base_url=$('qwen-region').value==='custom'?$('qwen-url').value:$('qwen-region').value;
      value.thinking=current.thinking;
      const result=$('qwen-result');
      $('qwen-test').disabled=true;$('qwen-save').disabled=true;
      result.className='';result.textContent=test?'正在调用千问，请稍候…':'正在保存…';
      try{
        const response=await post(test?'/api/settings/qwen/test':'/api/settings/qwen',value);
        if(test)result.textContent=`${response.message}${response.translation?' 示例翻译：'+response.translation:''}`;
        else{
          $('qwen-key').value='';$('qwen-key').required=false;$('qwen-key').placeholder='已保存；留空沿用原 Key';
          result.textContent='已保存并立即生效。现在可以关闭设置，上传聊天截图或粘贴客户原话进行分析。';
          state.status=await api('/api/status');renderModelStatus();
        }
      }catch(error){result.className='error-text';result.textContent=error.message;}
      finally{value.api_key='';if($('qwen-test'))$('qwen-test').disabled=false;if($('qwen-save'))$('qwen-save').disabled=false;}
    }
    form.onsubmit=event=>{event.preventDefault();submit(false);};
    $('qwen-test').onclick=()=>submit(true);
  }catch(error){toast(error.message,true);}
}
$('settings-btn').onclick=()=>{if(location.hash==='#settings')settings();else location.hash='settings';};
window.addEventListener('hashchange',()=>{if(location.hash==='#settings')settings();});
$('small-dialog').addEventListener('close',()=>{if($('qwen-form')){$('qwen-key').value='';$('small-body').innerHTML='';if(location.hash==='#settings')history.replaceState(null,'',location.pathname+location.search);}});
$('login-form').onsubmit=async e=>{e.preventDefault();try{await post('/api/login',Object.fromEntries(new FormData(e.target)));$('login-dialog').close();await init();}catch(e){$('login-error').textContent=e.message;}};
$('login-dialog').addEventListener('cancel',e=>e.preventDefault());
$('logout-btn').onclick=async()=>{try{await post('/api/logout',{});location.reload();}catch(e){toast(e.message,true);}};
async function init(){
  try{state.status=await api('/api/status');renderModelStatus();$('logout-btn').hidden=!state.status.password_required;if(!state.status.authenticated){if(!$('login-dialog').open)$('login-dialog').showModal();return;}await refreshCustomers();await refreshDrafts();renderReplies(state.detail?.latest);if(location.hash==='#settings')await settings();}
  catch(e){toast(e.message,true);}
}
await init();
