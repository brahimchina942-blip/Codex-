import { readFileSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError, object } from './core.mjs';

const officialHost = host => ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(host) || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1)\.maas\.aliyuncs\.com$/.test(host);

export class QwenSettings {
  constructor(config) {
    this.original = config;
    this.file = join(config.dataDir, 'qwen-settings.json');
    this.saved = null;
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20000) throw new Error();
      this.saved = this.validate(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('千问配置文件无法读取，请检查服务器私有配置。');
    }
  }
  config() { return { ...this.original, ...this.saved }; }
  view() {
    const config = this.config();
    return { configured: !!(config.apiKey && config.baseUrl && !config.baseUrl.includes('YOUR_WORKSPACE_ID')), has_key: !!config.apiKey,
      base_url: config.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: config.model, thinking: config.thinking };
  }
  validate(value) {
    if (!object(value)) throw new HttpError(400, '请填写千问设置。');
    const current = this.config();
    const apiKey = value.apiKey ?? value.api_key ?? current.apiKey;
    const baseUrl = value.baseUrl ?? value.base_url ?? current.baseUrl;
    const model = value.model ?? current.model;
    const key = typeof apiKey === 'string' ? apiKey.trim() || current.apiKey : '';
    if (!key || key.length > 2048 || /[^\x21-\x7e]/.test(key)) throw new HttpError(400, '请填写有效的 API Key。');
    let url;
    try { url = new URL(typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''); } catch {}
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !officialHost(url.hostname) || url.pathname !== '/compatible-mode/v1')
      throw new HttpError(400, '请选择百炼地域，或填写官方 HTTPS 兼容接口地址（以 /compatible-mode/v1 结尾）。');
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model.trim())) throw new HttpError(400, '请填写百炼控制台提供的模型 ID。');
    return { apiKey: key, baseUrl: url.href.replace(/\/$/, ''), model: model.trim(), thinking: value.thinking === true };
  }
  preview(value) { return { ...this.original, ...this.validate(value) }; }
  save(value) {
    const next = this.validate(value);
    const temporary = join(this.original.dataDir, '.qwen-settings-' + randomUUID() + '.tmp');
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    this.saved = next;
    return this.view();
  }
}
