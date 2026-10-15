import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { Store } from './lib/store.mjs';
import { HttpError, object, str, decodeImages, validateMessages } from './lib/core.mjs';
import { createQwen } from './lib/qwen.mjs';
import { DEMO } from './lib/demo.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const loopback = h => ['127.0.0.1', 'localhost', '::1'].includes(h);
export function readConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1', password = env.APP_PASSWORD || '', origin = env.APP_ORIGIN || '';
  if (!loopback(host) && (password.length < 12 || !origin)) throw new Error('非本机访问必须配置至少12位 APP_PASSWORD 和 APP_ORIGIN；请通过 HTTPS 反向代理访问。');
  return {
    host, port: Number(env.PORT || 3000), password, origin,
    dataDir: resolve(root, env.DATA_DIR || './data'),
    apiKey: env.DASHSCOPE_API_KEY || '', baseUrl: env.DASHSCOPE_BASE_URL || '',
    model: env.QWEN_MODEL || 'qwen3.7-plus', thinking: env.QWEN_ENABLE_THINKING === 'true',
    timeout: Math.max(1000, Math.min(180000, Number(env.QWEN_TIMEOUT_MS) || 120000))
  };
}
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请求需为 JSON。');
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 46 * 1024 ** 2) throw new HttpError(413, '请求太大，请减少截图数量。');
    chunks.push(chunk);
  }
  try { const v = JSON.parse(Buffer.concat(chunks).toString()); if (!object(v)) throw new Error(); return v; }
  catch { throw new HttpError(400, '请求 JSON 无效。'); }
}
const idPattern = '[a-f0-9-]{36}';
export function createApp(config = readConfig(), options = {}) {
  const store = options.store || new Store(config.dataDir), analyze = options.analyze || createQwen(config);
  const sign = timestamp => createHmac('sha256', config.password).update(timestamp).digest('hex');
  const attempts = new Map();
  const active = new Set();
  function auth(req) {
    if (!config.password) return true;
    const token = req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('crm_session='))?.slice(12) || '';
    const [timestamp, mac] = token.split('.');
    if (!/^\d{13}$/.test(timestamp || '') || !/^[a-f0-9]{64}$/.test(mac || '')) return false;
    const age = Date.now() - Number(timestamp);
    return age >= 0 && age < 8 * 60 * 60 * 1000 && timingSafeEqual(Buffer.from(mac), Buffer.from(sign(timestamp)));
  }
  const server = createServer(async (req, res) => {
    const send = (status, value, extra = {}) => { res.writeHead(status, { ...jsonHeaders, ...extra }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      const allowedHost = config.origin ? new URL(config.origin).host : null;
      if (allowedHost ? host !== allowedHost : !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) throw new HttpError(403, '访问地址未授权。');
      const origin = config.origin || `http://${host}`;
      const path = new URL(req.url, origin).pathname, method = req.method;
      const publicNavigation = method === 'GET' && path === '/' &&
        req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (!publicNavigation && (req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site')) throw new HttpError(403, '不允许跨站请求。');
      if (method === 'GET' && path === '/api/status') return send(200, {
        authenticated: auth(req), password_required: !!config.password,
        qwen_configured: !!(config.apiKey && config.baseUrl && !config.baseUrl.includes('YOUR_WORKSPACE_ID')),
        model: config.model, version: '0.2.0'
      });
      if (method === 'POST' && path === '/api/login') {
        const ip = req.socket.remoteAddress || 'local', entry = attempts.get(ip) || { count: 0, until: 0 };
        if (entry.until > Date.now()) throw new HttpError(429, '尝试次数过多，请一分钟后重试。');
        const body = await readJson(req), password = str(body.password, 1000);
        const digest = v => createHash('sha256').update(v).digest();
        if (!timingSafeEqual(digest(password), digest(config.password))) {
          entry.count++; if (entry.count >= 5) { entry.until = Date.now() + 60000; entry.count = 0; }
          attempts.set(ip, entry); throw new HttpError(401, '密码不正确。');
        }
        attempts.delete(ip);
        const ts = String(Date.now());
        return send(200, { ok: true }, { 'Set-Cookie': `crm_session=${ts}.${sign(ts)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${origin.startsWith('https:') ? '; Secure' : ''}` });
      }
      if (method === 'POST' && path === '/api/logout') return send(200, { ok: true }, { 'Set-Cookie': 'crm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      if (path.startsWith('/api/') && !auth(req)) throw new HttpError(401, '请先登录。');
      if (method === 'GET' && path === '/api/customers') return send(200, store.customers(new URL(req.url, origin).searchParams.get('q') || ''));
      if (method === 'POST' && path === '/api/customers') {
        const b = await readJson(req);
        return send(201, store.createCustomer({ name: str(b.name,120,true), phone: str(b.phone||'',80), city: str(b.city||'',100), preferred_language: str(b.preferred_language||'',80) }));
      }
      let match;
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})/shipments$`)))) {
        if (method === 'GET') return send(200, store.shipments(match[1]));
        if (method === 'POST') return send(201, store.createShipment(match[1], await readJson(req)));
      }
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})/shipments/(${idPattern})$`))) && method === 'PATCH')
        return send(200, store.updateShipment(match[2], match[1], await readJson(req)));
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})/shipments/(${idPattern})/quotes$`)))) {
        if (method === 'GET') return send(200, store.quotes(match[1], match[2]));
        if (method === 'POST') return send(201, store.createQuote(match[1], match[2], await readJson(req)));
      }
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})$`)))) {
        if (method === 'GET') {
          const params = new URL(req.url, origin).searchParams;
          return send(200, store.detail(match[1], params.get('q') || '', params.get('shipment_id') || null));
        }
        if (method === 'PATCH') {
          const b = await readJson(req), patch = {};
          for (const k of ['name','phone','city','status','preferred_language']) if (b[k] !== undefined) patch[k] = str(b[k], k==='phone'?80:120,k==='name');
          return send(200, store.updateCustomer(match[1], patch));
        }
      }
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})/export$`))) && method === 'GET')
        return send(200, store.exportCustomer(match[1]), { 'Content-Disposition': 'attachment; filename="customer-export.json"' });
      if (method === 'GET' && path === '/api/drafts') return send(200, store.readyDrafts());
      if (method === 'POST' && path === '/api/analyze') {
        if (active.size >= 2) throw new HttpError(429, '已有分析正在进行，请稍后重试。');
        const b = await readJson(req), text = str(b.text || '', 16000), images = decodeImages(b.images || []);
        const customerId = b.customer_id ? str(b.customer_id, 36, true) : null;
        const shipmentId = b.shipment_id ? str(b.shipment_id, 36, true) : null;
        if (shipmentId && !customerId) throw new HttpError(400, '选择运输需求前请确认客户。');
        if (!text && !images.length) throw new HttpError(400, '请上传截图或输入聊天文字。');
        const key = Symbol(); active.add(key);
        try {
          const analysis = await analyze({ text, images, context: store.context(customerId, text, shipmentId) });
          return send(201, store.saveDraft({ customerId, shipmentId, analysis, images }));
        } finally { active.delete(key); }
      }
      if (method === 'POST' && path === '/api/demo') {
        await readJson(req);
        return send(201, store.saveDraft({ analysis: structuredClone(DEMO), demo: true }));
      }
      if ((match = path.match(new RegExp(`^/api/drafts/(${idPattern})$`)))) {
        if (method === 'GET') return send(200, store.draft(match[1]));
        if (method === 'DELETE') { store.removeDraft(match[1]); return send(200, { ok: true }); }
      }
      if ((match = path.match(new RegExp(`^/api/drafts/(${idPattern})/commit$`))) && method === 'POST') {
        const b = await readJson(req), draft = store.draft(match[1]), messages = validateMessages(b.messages);
        if (messages.length !== draft.analysis.messages.length) throw new HttpError(400, '消息数量与草稿不一致，请重新分析。');
        if (messages.some(m=>m.speaker==='unknown')) throw new HttpError(400, '请先确认所有消息的发送方。');
        if (!Array.isArray(b.accepted_facts) || b.accepted_facts.length > 40) throw new HttpError(400, '记忆审核数据无效。');
        const indices = new Set();
        const acceptedFacts = b.accepted_facts.map(f=>{
          if (!object(f) || !Number.isInteger(f.index) || !draft.analysis.facts[f.index] || indices.has(f.index)) throw new HttpError(400, '记忆来源无效或重复。');
          indices.add(f.index); return { index:f.index, value:str(f.value,1500,true) };
        });
        const newCustomer = b.new_customer ? { name:str(b.new_customer.name,120,true), phone:str(b.new_customer.phone||'',80) } : null;
        const shipmentId = b.shipment_id ? str(b.shipment_id, 36, true) : null;
        return send(200, store.commit(match[1], { customerId:b.customer_id || null, newCustomer, messages, acceptedFacts, shipmentId, newShipment:b.new_shipment || null }));
      }
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})/messages/(${idPattern})$`)))) {
        if (method === 'PATCH') {
          const b = await readJson(req), message = validateMessages([b])[0];
          if (message.speaker==='unknown') throw new HttpError(400, '请确认消息发送方。');
          store.editMessage(match[2],match[1],message); return send(200,{ok:true});
        }
        if (method === 'DELETE') { store.deleteMessage(match[2],match[1]); return send(200,{ok:true}); }
      }
      if ((match = path.match(new RegExp(`^/api/screenshots/(${idPattern})$`))) && method === 'GET') {
        const image = store.screenshot(match[1]);
        res.writeHead(200, { 'Content-Type':image.mime,'Cache-Control':'no-store','Content-Disposition':'inline' });
        return res.end(readFileSync(join(config.dataDir,image.path)));
      }
      const staticFiles = { '/':'index.html', '/app.js':'app.js', '/styles.css':'styles.css' };
      if (method === 'GET' && staticFiles[path]) {
        const file = staticFiles[path];
        res.writeHead(200,{ 'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-cache' });
        return res.end(readFileSync(join(root,'public',file)));
      }
      throw new HttpError(404,'页面或接口不存在。');
    } catch (error) {
      if (!res.headersSent) send(error instanceof HttpError ? error.status : 500, { error:error instanceof HttpError ? error.message : '服务处理失败，请重试并检查本机数据目录权限。' });
      else res.end();
    }
  });
  server.requestTimeout = 180000;
  return { server, store };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfig();
  const { server, store } = createApp(config);
  server.listen(config.port, config.host, () => console.log(`Morocco AI CRM 已启动：http://${config.host}:${config.port}`));
  const stop = () => server.close(()=>{store.close();process.exit(0);});
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
