# HTTP API v0.2（兼容v0.1未分类记录）

与网页同源，JSON输入，返回JSON。错误格式 `{"error":"中文提示"}`；配置密码时须有登录会话，截图与导出也受保护。调用方不能自行选择其他上游模型接口。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/status` | 版本、模型ID、配置存在状态、登录状态 |
| POST | `/api/login` | `{password}`，写HttpOnly/SameSite会话 |
| POST | `/api/logout` | 清除当前浏览器会话 |
| GET | `/api/customers?q=` | 客户列表，姓名/电话/城市/状态/最近翻译搜索 |
| POST | `/api/customers` | `{name,phone?,city?,preferred_language?}` |
| GET | `/api/customers/:id?q=` | 客户、消息、事实及最近归档分析 |
| PATCH | `/api/customers/:id` | 人工改姓名/电话/城市/语言/状态 |
| GET | `/api/customers/:id/export` | 客户文字档案JSON；不含截图二进制 |
| POST | `/api/analyze` | `{customer_id?,text?,images:[{name,data:DataURL}]}` |
| POST | `/api/demo` | 固定示例草稿，输入 `{}`；无收费调用 |
| GET | `/api/drafts` | 最近20份待审核草稿 |
| GET / DELETE | `/api/drafts/:id` | 读取/删除未归档草稿及未归档截图 |
| POST | `/api/drafts/:id/commit` | 审核结果归档，结构见下文 |
| PATCH / DELETE | `/api/customers/:id/messages/:mid` | 校对/删除，相关事实和回复失效 |
| GET | `/api/screenshots/:id` | PNG/JPEG/WebP原截图 |
| GET / POST | `/api/customers/:id/shipments` | 列出/新建运输需求，创建输入`{title,status?,notes?}` |
| PATCH | `/api/customers/:id/shipments/:sid` | 修改名称/状态/备注，并停用该票旧回复 |
| GET / POST | `/api/customers/:id/shipments/:sid/quotes` | 列出/手动新增不可改价的报价记录 |

`GET /api/customers/:id`可用`shipment_id`参数选择最近分析。响应增加`shipments[]`和`quotes[]`；`messages[]`、`facts[]`仍包含该客户所有记录，客户端须按`shipment_id`筛选，联系方式/语言为客户全局。默认最近分析属于未分类。

`POST /api/analyze`接受可选`shipment_id`，必须同时提供该运输需求所属的`customer_id`。模型上下文只含所选票的业务事实、消息及报价，另包含该客户的全局联系方式/语言；未选票时只含未分类记录，不混入其他票数据。

## 分析结果

`draft` 包含 `id`、`customer_id`、`shipment_id`、`status`、`demo`、`screenshots` 与 `analysis`。

`analysis.messages[]` 包含 `speaker(customer/self/unknown)`、`original`、`chinese`、`language`、`visible_time`、`uncertain`。`facts[]` 包含 `field`、`value`、`certainty(stated/inferred)`、`message_index`（零基）。`replies[]` 包含风格、客户语言文本、中文意思与语言。另有 `summary`、`intent`、`warnings` 和候选 `identity`。

## 人工归档

```json
{
  "customer_id": "已确认的客户ID",
  "new_customer": null,
  "messages": [
    {"speaker":"customer","original":"Salam","chinese":"你好","language":"Darija","visible_time":"","uncertain":false}
  ],
  "accepted_facts": [{"index":0,"value":"经核对的事实值"}]
}
```

创建客户时改为 `customer_id:null,new_customer:{name,phone}`。消息数量与草稿一致，需将unknown改为已确认发送方；只更新原消息内容，不允许替换来源索引。服务端读取已保存草稿中的事实类型和来源，不信任客户端任意提交的事实字段。

归档输入可加`shipment_id`，或`new_shipment:{title,status?,notes?}`（二者互斥），支持原子新建客户与运输需求。空或省略归属保留v0.1未分类行为。客户联系方式和语言的事实归属为null，货物等业务事实归属为本批所选票。同字段只在同一归属内更新版本。

若分析时绑定过客户或运输需求，只能归档给同一客户和同一票。更换绑定归属须重新分析；未绑定需求的草稿可人工选择/新建需求，但原回复会停用，须再次分析。重复提交已归档草稿返回409。响应 `{customer_id,shipment_id,inserted,skipped}`。

## 报价记录

新增输入：`{amount:"1250.50",currency:"USD",scope:"海运至港，不含税费",valid_until:"2026-12-31",status:"草稿",notes:"",evidence_message_id:null}`。

金额是正十进制字符串（最多12位整数、2位小数），支持CNY/USD/EUR/MAD/AED/GBP。范围必填，日期需合法，可留空。状态为草稿/已向客户报价/客户已确认/已过期/已拒绝。状态仅记录人工判断，不执行发送或公司确认。

有来源时必须是该客户、该票已归档消息。修改/删除来源使报价`state=needs_review`；删除消息会保留金额及范围，但来源ID置null。新报价不会覆盖旧金额；新报价或需求更改使该票旧回复停用。AI上下文中有`usable_for_reference`区分草稿/过期记录，待复核记录不注入。当前尚无报价修改、状态更新或复核接口，修订须新增完整记录。

客户导出格式为`morocco-ai-crm/2`，包含所有运输需求、报价、消息和事实，仍不含截图文件。

## 自定义回复翻译

登录后 `POST /api/replies/translate`，输入 `{text:"请确认包装后的体积。",languages:["en","fr"]}`。支持en/fr/ar/darija/es，至少选一项、不重复，中文原文最多6000字符。返回 `{translations:[{language:"en",label:"英语",text:"..."},...]}`，按选择顺序输出。只调用千问翻译本次原文，不发送客户记忆，不建立草稿或正式消息；格式不全、截断和上游错误均明确失败，不返回部分结果。沿用登录和同源检查，与分析接口共用并发限制。

## 右侧记忆分区

客户详情新增 `memory`：基于该客户全部已归档消息、有效事实和运输需求生成，包含message_count/record_count/shipment_count/needs_review_count和sections。每个section包含归属、标题、文字概括及fact_ids；搜索条件和当前选择的票不缩小此汇总，运输需求始终分组。未归档草稿不进入汇总，superseded/needs_review事实不作为当前结论。

`latest`仍为当前所选票（或未分类）的最近一次已归档分析，新增screenshots列表，供展示本次图片数量和摘要。前端对归属于当前客户和所选票的待审草稿单独显示待确认摘要，不写入正式记忆。

## 双语记忆

详情 `memory` 新增revision，sections新增items；每项包括fact_id、原文original、中文chinese、字段标签label和certainty。已有中文直接显示，外文缺少译文时chinese为null；服务端会返回当前进程已缓存的有效中文。

登录后 `POST /api/customers/:id/memory/translate`，输入 `{revision:"详情中的版本",fact_ids:["当前客户的有效事实ID"]}`，一次最多10项。仅翻译已保存的事实值，返回 `{revision,translations:[{fact_id,chinese}]}`，不写入客户资料。既有缓存可复用；来源变更后重新计算版本，提交旧版本或翻译途中发生变更均返回409。拒绝其他客户、已失效事实、缺少/重复ID的模型结果，沿用登录、同源和并发保护。翻译缓存不包含API Key，不作为正式事实或数据库备份的一部分。
