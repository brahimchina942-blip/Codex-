import { fields, customerFields, sha } from './core.mjs';

export const memoryFactKey = fact => sha(JSON.stringify([fact.id,fact.customer_id,fact.shipment_id,fact.field,fact.value,fact.evidence,fact.evidence_chinese,fact.state]));
const bilingualItem = fact => ({fact_id:fact.id,key:memoryFactKey(fact),label:fields[fact.field]||fact.field,certainty:fact.certainty,
  original:/\p{Script=Han}/u.test(fact.value)?fact.evidence||fact.value:fact.value,
  original_label:/\p{Script=Han}/u.test(fact.value)&&fact.evidence?'来源消息原文':'资料原文',
  chinese:/\p{L}/u.test(fact.value.replace(/\p{Script=Han}/gu,''))?null:fact.value});

// Rebuild from all reviewed source facts, so edits and deletions cannot leave
// a cached narrative presenting superseded or invalidated information as current.
export function summarizeMemory({customer,messages,facts,shipments},recordCount){
  const active=facts.filter(f=>f.state==='active');
  const describe=items=>items.map(f=>`${fields[f.field]||f.field}：${f.value}${f.certainty==='inferred'?'（AI推测）':''}`).join('；');
  const sections=[];
  const shared=active.filter(f=>customerFields.has(f.field));
  if(shared.length)sections.push({shipment_id:null,title:'客户通用信息',text:describe(shared),fact_ids:shared.map(f=>f.id),items:shared.map(bilingualItem)});
  const scopes=[{id:null,title:'未分类 / 一般沟通'},...shipments];
  for(const scope of scopes){
    const items=active.filter(f=>(f.shipment_id||null)===scope.id&&!customerFields.has(f.field));
    const count=messages.filter(m=>(m.shipment_id||null)===scope.id).length;
    if(!items.length&&!count&&!scope.notes)continue;
    const description=describe(items);
    const note=scope.notes?`人工备注：${scope.notes}`:'';
    sections.push({shipment_id:scope.id,title:scope.title,status:scope.status||'',message_count:count,
      text:[description||`已归档 ${count} 条消息，暂无已审核的有效货物记忆。`,note].filter(Boolean).join('；'),fact_ids:items.map(f=>f.id),items:items.map(bilingualItem),note});
  }
  return {message_count:messages.length,record_count:recordCount,shipment_count:shipments.length,active_fact_count:active.length,
    needs_review_count:facts.filter(f=>f.state==='needs_review').length,
    revision:sha(JSON.stringify(active.map(memoryFactKey).sort())),
    introduction:`${customer.name}：共 ${messages.length} 条已归档聊天记录、${recordCount} 次归档，${shipments.length} 票运输需求。`,sections};
}
