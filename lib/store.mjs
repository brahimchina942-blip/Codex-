import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { summarizeMemory } from './memory.mjs';
import { HttpError, sha, signature, overlap, retrievalTerms, customerFields, validateShipment, validateQuote } from './core.mjs';

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'crm.sqlite'));
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) { this.db.close(); throw new Error('数据库版本比程序更新，不能降级打开。'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '新询盘', preferred_language TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, customer_id TEXT REFERENCES customers(id), analysis TEXT NOT NULL,
        demo INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ready', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS screenshots (
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        hash TEXT NOT NULL, path TEXT NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        speaker TEXT NOT NULL, original TEXT NOT NULL, chinese TEXT NOT NULL, language TEXT NOT NULL,
        visible_time TEXT NOT NULL, uncertain INTEGER NOT NULL DEFAULT 0, draft_id TEXT REFERENCES drafts(id),
        signature TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_customer ON messages(customer_id, created_at);
      CREATE TABLE IF NOT EXISTS message_sources (
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        screenshot_id TEXT REFERENCES screenshots(id) ON DELETE CASCADE,
        PRIMARY KEY (message_id, screenshot_id)
      );
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        field TEXT NOT NULL, value TEXT NOT NULL, certainty TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active',
        evidence_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fact_customer ON facts(customer_id, state, field);
      CREATE TABLE IF NOT EXISTS receipts (
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, message_ids TEXT NOT NULL, PRIMARY KEY(customer_id, fingerprint)
      );
    `);
    if (version < 2) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE shipments (
          id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          title TEXT NOT NULL, status TEXT NOT NULL DEFAULT '询价中', notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX shipment_customer ON shipments(customer_id);
        ALTER TABLE drafts ADD COLUMN shipment_id TEXT REFERENCES shipments(id);
        ALTER TABLE messages ADD COLUMN shipment_id TEXT REFERENCES shipments(id);
        ALTER TABLE facts ADD COLUMN shipment_id TEXT REFERENCES shipments(id);
        ALTER TABLE receipts RENAME TO receipts_v1;
        CREATE TABLE receipts (
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          shipment_scope TEXT NOT NULL, fingerprint TEXT NOT NULL, message_ids TEXT NOT NULL,
          PRIMARY KEY(customer_id, shipment_scope, fingerprint)
        );
        INSERT INTO receipts SELECT customer_id, '', fingerprint, message_ids FROM receipts_v1;
        DROP TABLE receipts_v1;
        CREATE TABLE quotes (
          id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          shipment_id TEXT NOT NULL REFERENCES shipments(id), amount TEXT NOT NULL, currency TEXT NOT NULL,
          scope TEXT NOT NULL, valid_until TEXT NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL,
          evidence_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
          state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
        );
        CREATE INDEX quote_shipment ON quotes(shipment_id);
        PRAGMA user_version=2;
      `);
    });
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  customer(id) {
    const c = this.db.prepare('SELECT * FROM customers WHERE id=?').get(id);
    if (!c) throw new HttpError(404, '客户不存在。');
    return c;
  }
  createCustomer({ name, phone = '', city = '', preferred_language = '' }) {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO customers (id,name,phone,city,preferred_language,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, name, phone, city, preferred_language, now, now);
    return this.customer(id);
  }
  updateCustomer(id, patch) {
    this.customer(id);
    const columns = ['name', 'phone', 'city', 'status', 'preferred_language'].filter(k => patch[k] !== undefined);
    if (columns.length) this.db.prepare(`UPDATE customers SET ${columns.map(c => `${c}=?`).join(',')},updated_at=? WHERE id=?`)
      .run(...columns.map(c => patch[c]), new Date().toISOString(), id);
    return this.customer(id);
  }
  customers(query = '') {
    const all = this.db.prepare(`SELECT c.*,
      (SELECT chinese FROM messages WHERE customer_id=c.id ORDER BY rowid DESC LIMIT 1) AS last_message,
      (SELECT COUNT(*) FROM messages WHERE customer_id=c.id) AS message_count
      FROM customers c ORDER BY updated_at DESC, rowid DESC`).all();
    const q = query.toLowerCase().trim();
    return q ? all.filter(c => [c.name, c.phone, c.city, c.status, c.last_message || ''].some(v => v.toLowerCase().includes(q))) : all;
  }
  shipment(id, customerId) {
    this.customer(customerId);
    const row = this.db.prepare('SELECT * FROM shipments WHERE id=? AND customer_id=?').get(id, customerId);
    if (!row) throw new HttpError(404, '该客户的运输需求不存在。');
    return row;
  }
  shipments(customerId) {
    this.customer(customerId);
    return this.db.prepare('SELECT * FROM shipments WHERE customer_id=? ORDER BY rowid DESC').all(customerId);
  }
  createShipment(customerId, input) {
    this.customer(customerId);
    const { title, notes, status } = validateShipment(input), id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO shipments VALUES (?,?,?,?,?,?,?)').run(id, customerId, title, status, notes, now, now);
    this.db.prepare('UPDATE customers SET updated_at=? WHERE id=?').run(now, customerId);
    return this.shipment(id, customerId);
  }
  updateShipment(id, customerId, input) {
    this.shipment(id, customerId);
    const patch = validateShipment(input, true), keys = Object.keys(patch);
    if (keys.length) this.transaction(() => {
      this.db.prepare(`UPDATE shipments SET ${keys.map(k => `${k}=?`).join(',')},updated_at=? WHERE id=? AND customer_id=?`)
        .run(...keys.map(k => patch[k]), new Date().toISOString(), id, customerId);
      this.staleReplies(customerId, id);
    });
    return this.shipment(id, customerId);
  }
  quotes(customerId, shipmentId) {
    this.shipment(shipmentId, customerId);
    return this.db.prepare('SELECT * FROM quotes WHERE customer_id=? AND shipment_id=? ORDER BY rowid DESC').all(customerId, shipmentId);
  }
  createQuote(customerId, shipmentId, input) {
    this.shipment(shipmentId, customerId);
    const q = validateQuote(input);
    if (q.evidence_message_id && !this.db.prepare('SELECT id FROM messages WHERE id=? AND customer_id=? AND shipment_id=?').get(q.evidence_message_id, customerId, shipmentId))
      throw new HttpError(400, '报价来源必须是这位客户、这票运输需求的已归档消息。');
    const id = randomUUID(), now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO quotes (id,customer_id,shipment_id,amount,currency,scope,valid_until,status,notes,evidence_message_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, customerId, shipmentId, q.amount, q.currency, q.scope, q.valid_until, q.status, q.notes, q.evidence_message_id, now);
      this.staleReplies(customerId, shipmentId);
    });
    return this.db.prepare('SELECT * FROM quotes WHERE id=?').get(id);
  }
  messages(id, q = '') {
    this.customer(id);
    const rows = this.db.prepare('SELECT rowid AS seq,* FROM messages WHERE customer_id=? ORDER BY rowid').all(id);
    const query = q.toLowerCase();
    return rows.filter(m => !query || `${m.original} ${m.chinese}`.toLowerCase().includes(query)).map(m => ({
      ...m, screenshots: this.db.prepare(`SELECT s.id,s.name FROM screenshots s JOIN message_sources ms ON ms.screenshot_id=s.id WHERE ms.message_id=?`).all(m.id)
    }));
  }
  detail(id, query = '', shipmentId = null) {
    if (shipmentId) this.shipment(shipmentId, id);
    const customer=this.customer(id),allMessages=this.messages(id),shipments=this.shipments(id);
    const facts=this.db.prepare(`SELECT f.*,m.original AS evidence,m.chinese AS evidence_chinese,m.visible_time AS evidence_time
        FROM facts f JOIN messages m ON f.evidence_message_id=m.id WHERE f.customer_id=? ORDER BY f.rowid DESC`).all(id);
    const recordCount=this.db.prepare("SELECT COUNT(*) AS count FROM drafts WHERE customer_id=? AND status='committed'").get(id).count;
    const search=query.toLowerCase();
    return {
      customer, messages:allMessages.filter(m=>!search||`${m.original} ${m.chinese}`.toLowerCase().includes(search)), facts, shipments,
      memory:summarizeMemory({customer,messages:allMessages,facts,shipments},recordCount),
      quotes: this.db.prepare('SELECT * FROM quotes WHERE customer_id=? ORDER BY rowid DESC').all(id),
      latest: this.latest(id, shipmentId)
    };
  }
  latest(id, shipmentId = null) {
    const d = this.db.prepare(`SELECT * FROM drafts WHERE customer_id=? AND shipment_id IS ? AND status='committed' ORDER BY rowid DESC LIMIT 1`).get(id, shipmentId);
    if (!d) return null;
    return { ...JSON.parse(d.analysis), id: d.id, shipment_id: d.shipment_id, demo: !!d.demo, created_at: d.created_at,
      screenshots:this.db.prepare('SELECT id,name FROM screenshots WHERE draft_id=?').all(d.id) };
  }
  context(id, text = '', shipmentId = null) {
    if (!id) return { customer: null, facts: [], recent_messages: [], relevant_history: [] };
    const customer = this.customer(id), shipment = shipmentId ? this.shipment(shipmentId, id) : null;
    const facts = this.db.prepare("SELECT field,value,certainty,evidence_message_id,shipment_id FROM facts WHERE customer_id=? AND state='active' AND (shipment_id IS ? OR (shipment_id IS NULL AND field IN ('contact','language'))) ORDER BY rowid DESC LIMIT 60").all(id, shipmentId);
    const all = this.db.prepare('SELECT id,speaker,original,chinese,visible_time FROM messages WHERE customer_id=? AND shipment_id IS ? ORDER BY rowid DESC LIMIT 1000').all(id, shipmentId);
    const terms = retrievalTerms(text);
    const recent = all.slice(0, 20).reverse();
    const ids = new Set(recent.map(m => m.id));
    const relevant = all.filter(m => !ids.has(m.id)).map(m => ({ m, score: terms.reduce((s,t) => s + Number(`${m.original} ${m.chinese}`.toLowerCase().includes(t)), 0) }))
      .filter(x => x.score).sort((a,b) => b.score-a.score).slice(0, 8).map(x => x.m);
    const bound = rows => rows.map(m => ({ ...m, original: m.original.slice(0, 700), chinese: m.chinese.slice(0, 700) }));
    const asOf = new Date().toISOString();
    const quotes = shipmentId ? this.quotes(id, shipmentId).filter(q => q.state === 'active').slice(0, 10).map(q => ({...q,
      usable_for_reference: ['已向客户报价','客户已确认'].includes(q.status) && (!q.valid_until || q.valid_until >= asOf.slice(0,10))
    })) : [];
    return { customer, shipment, as_of: asOf, available_shipments: this.shipments(id).map(s => ({id:s.id,title:s.title,status:s.status})), quotes,
      facts, recent_messages: bound(recent), relevant_history: bound(relevant) };
  }
  saveDraft({ customerId = null, shipmentId = null, analysis, images = [], demo = false }) {
    if (customerId) this.customer(customerId);
    if (shipmentId) this.shipment(shipmentId, customerId);
    const id = randomUUID(), files = [];
    try {
      this.transaction(() => {
        this.db.prepare('INSERT INTO drafts (id,customer_id,shipment_id,analysis,demo,created_at) VALUES (?,?,?,?,?,?)')
          .run(id, customerId, shipmentId, JSON.stringify(analysis), Number(demo), new Date().toISOString());
        for (const image of images) {
          const sid = randomUUID(), ext = image.mime === 'image/png' ? 'png' : image.mime === 'image/jpeg' ? 'jpg' : 'webp';
          const path = join('uploads', `${sid}.${ext}`);
          writeFileSync(join(this.dataDir, path), image.bytes, { mode: 0o600 }); files.push(path);
          this.db.prepare('INSERT INTO screenshots VALUES (?,?,?,?,?,?)').run(sid, id, image.hash, path, image.mime, image.name);
        }
      });
    } catch (e) { for (const path of files) { try { unlinkSync(join(this.dataDir, path)); } catch {} } throw e; }
    return this.draft(id);
  }
  draft(id) {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
    if (!row) throw new HttpError(404, '分析草稿不存在。');
    return { ...row, demo: !!row.demo, analysis: JSON.parse(row.analysis), screenshots: this.db.prepare('SELECT id,name,hash FROM screenshots WHERE draft_id=?').all(id) };
  }
  readyDrafts() {
    return this.db.prepare("SELECT id,customer_id,shipment_id,demo,created_at FROM drafts WHERE status='ready' ORDER BY rowid DESC LIMIT 20").all();
  }
  removeDraft(id) {
    const draft = this.draft(id);
    if (draft.status !== 'ready') throw new HttpError(409, '已归档记录不能作为草稿删除。');
    const paths = this.db.prepare('SELECT path FROM screenshots WHERE draft_id=?').all(id);
    this.db.prepare('DELETE FROM drafts WHERE id=?').run(id);
    for (const { path } of paths) { try { unlinkSync(join(this.dataDir, path)); } catch {} }
  }
  commit(id, { customerId, newCustomer, messages, acceptedFacts, shipmentId = null, newShipment = null }) {
    return this.transaction(() => {
      const draft = this.draft(id);
      if (draft.status !== 'ready') throw new HttpError(409, '该草稿已经归档，请勿重复提交。');
      // 防止使用 A 的上下文产生的分析被归档给 B。
      if (draft.customer_id && (customerId !== draft.customer_id || newCustomer)) throw new HttpError(409, '该分析使用了所选客户的历史记忆。更换客户后请重新分析。');
      if (draft.shipment_id && (shipmentId !== draft.shipment_id || newShipment)) throw new HttpError(409, '该分析使用了所选运输需求的记忆。更换运输需求后请重新分析。');
      if (shipmentId && newShipment) throw new HttpError(400, '不能同时选择和新建运输需求。');
      const customer = newCustomer ? this.createCustomer(newCustomer) : this.customer(customerId);
      if (newShipment) shipmentId = this.createShipment(customer.id, newShipment).id;
      if (shipmentId) this.shipment(shipmentId, customer.id);
      const all = this.db.prepare('SELECT * FROM messages WHERE customer_id=? AND shipment_id IS ? ORDER BY rowid DESC LIMIT 150').all(customer.id, shipmentId).reverse();
      const fingerprint = draft.screenshots.length ? sha(JSON.stringify({ images: draft.screenshots.map(i=>i.hash).sort(), messages: messages.map(signature) })) : null;
      const receipt = fingerprint && this.db.prepare('SELECT message_ids FROM receipts WHERE customer_id=? AND shipment_scope=? AND fingerprint=?').get(customer.id, shipmentId || '', fingerprint);
      const oldIds = receipt ? JSON.parse(receipt.message_ids) : [];
      const validReceipt = oldIds.length === messages.length && oldIds.every((mid,i) => {
        const saved=this.db.prepare('SELECT signature FROM messages WHERE id=? AND customer_id=? AND shipment_id IS ?').get(mid,customer.id,shipmentId);
        return saved && saved.signature===signature(messages[i]);
      });
      const count = validReceipt ? messages.length : overlap(all, messages);
      const mapping = validReceipt ? oldIds : all.slice(-count || all.length).slice(0, count).map(m=>m.id);
      const now = new Date().toISOString();
      for (let i = count; i < messages.length; i++) {
        const m = messages[i], mid = randomUUID(); mapping[i] = mid;
        this.db.prepare(`INSERT INTO messages (id,customer_id,speaker,original,chinese,language,visible_time,uncertain,draft_id,signature,created_at,shipment_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(mid, customer.id, m.speaker, m.original, m.chinese, m.language, m.visible_time, Number(m.uncertain), id, signature(m), now, shipmentId);
      }
      for (const mid of mapping) for (const s of draft.screenshots)
        this.db.prepare('INSERT OR IGNORE INTO message_sources VALUES (?,?)').run(mid, s.id);
      // 按来源消息顺序更新，以便同一截图中15CBM→20CBM保持正确历史。
      for (const accepted of [...acceptedFacts].sort((a,b)=>draft.analysis.facts[a.index].message_index-draft.analysis.facts[b.index].message_index)) {
        const f = { ...draft.analysis.facts[accepted.index], value: accepted.value }, evidence = mapping[f.message_index];
        const factShipment = customerFields.has(f.field) ? null : shipmentId;
        if (this.db.prepare('SELECT id FROM facts WHERE customer_id=? AND shipment_id IS ? AND field=? AND value=? AND evidence_message_id=?').get(customer.id, factShipment, f.field, f.value, evidence)) continue;
        if (f.certainty === 'stated') this.db.prepare("UPDATE facts SET state='superseded' WHERE customer_id=? AND shipment_id IS ? AND field=? AND state='active' AND certainty='stated'").run(customer.id, factShipment, f.field);
        this.db.prepare('INSERT INTO facts (id,customer_id,field,value,certainty,state,evidence_message_id,created_at,shipment_id) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), customer.id, f.field, f.value, f.certainty, 'active', evidence, now, factShipment);
      }
      if (fingerprint) this.db.prepare('INSERT OR REPLACE INTO receipts VALUES (?,?,?,?)').run(customer.id, shipmentId || '', fingerprint, JSON.stringify(mapping));
      // 保留人工校对后的消息，回复未重新计算，所以有改动时标记待重新分析。
      const changed = draft.shipment_id !== shipmentId || JSON.stringify(draft.analysis.messages) !== JSON.stringify(messages);
      this.db.prepare("UPDATE drafts SET status='committed',customer_id=?,shipment_id=?,analysis=? WHERE id=?")
        .run(customer.id, shipmentId, JSON.stringify({ ...draft.analysis, messages, stale: changed }), id);
      this.db.prepare('UPDATE customers SET updated_at=? WHERE id=?').run(now, customer.id);
      return { customer_id: customer.id, shipment_id: shipmentId, inserted: messages.length - count, skipped: count };
    });
  }
  invalidate(id, customerId) {
    this.db.prepare("UPDATE facts SET state='needs_review' WHERE evidence_message_id=?").run(id);
    this.db.prepare("UPDATE quotes SET state='needs_review' WHERE evidence_message_id=? AND customer_id=?").run(id, customerId);
    this.staleReplies(customerId);
    this.db.prepare('UPDATE customers SET updated_at=? WHERE id=?').run(new Date().toISOString(), customerId);
  }
  staleReplies(customerId, shipmentId = undefined) {
    const drafts = shipmentId === undefined ? this.db.prepare("SELECT id,analysis FROM drafts WHERE customer_id=? AND status='committed'").all(customerId)
      : this.db.prepare("SELECT id,analysis FROM drafts WHERE customer_id=? AND shipment_id IS ? AND status='committed'").all(customerId, shipmentId);
    for (const draft of drafts) {
      this.db.prepare('UPDATE drafts SET analysis=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(draft.analysis), stale: true }), draft.id);
    }
  }
  editMessage(id, customerId, patch) {
    this.customer(customerId);
    const m = this.db.prepare('SELECT * FROM messages WHERE id=? AND customer_id=?').get(id, customerId);
    if (!m) throw new HttpError(404, '消息不存在。');
    this.transaction(() => {
      const updated = { ...m, ...patch };
      this.db.prepare('UPDATE messages SET speaker=?,original=?,chinese=?,language=?,visible_time=?,uncertain=?,signature=? WHERE id=?')
        .run(updated.speaker, updated.original, updated.chinese, updated.language, updated.visible_time, Number(updated.uncertain), signature(updated), id);
      this.invalidate(id, customerId);
    });
  }
  deleteMessage(id, customerId) {
    const m = this.db.prepare('SELECT id FROM messages WHERE id=? AND customer_id=?').get(id, customerId);
    if (!m) throw new HttpError(404, '消息不存在。');
    this.transaction(() => { this.invalidate(id, customerId); this.db.prepare('DELETE FROM messages WHERE id=?').run(id); });
  }
  screenshot(id) {
    const row = this.db.prepare('SELECT * FROM screenshots WHERE id=?').get(id);
    if (!row) throw new HttpError(404, '截图不存在。');
    return row;
  }
  exportCustomer(id) { return { format: 'morocco-ai-crm/2', exported_at: new Date().toISOString(), ...this.detail(id) }; }
}
