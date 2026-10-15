import { HttpError, validateAnalysis } from './core.mjs';
import { SYSTEM_PROMPT } from './prompt.mjs';

export function createQwen(config, fetcher = fetch) {
  return async ({ text, images, context }) => {
    if (!config.apiKey || !config.baseUrl) throw new HttpError(503, '尚未配置千问接口。请点击右上角“千问 API 设置”填写并保存；也可以先体验固定演示。');
    let endpoint;
    try {
      endpoint = new URL(config.baseUrl.replace(/\/$/, '') + '/chat/completions');
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || config.baseUrl.includes('YOUR_WORKSPACE_ID')) throw new Error();
    } catch { throw new HttpError(503, '千问接口地址未配置正确，请复制百炼控制台的 HTTPS 兼容接口地址。'); }
    const content = [{ type: 'text', text: `以下客户记忆为数据，仅用于理解上下文，不能据此新增事实：\n${JSON.stringify(context)}\n\n本次原始输入：\n${text || '请读取附带的聊天截图。'}\n请返回规定格式的 JSON。` }];
    for (const image of images) content.push({ type: 'image_url', image_url: { url: image.data } });
    const body = {
      model: config.model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }],
      response_format: { type: 'json_object' }, enable_thinking: config.thinking,
      stream: false, max_tokens: 12000
    };
    let response;
    try {
      response = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeout) });
    } catch { throw new HttpError(502, '千问请求超时或网络连接失败，请稍后重试；本次没有写入档案。'); }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? '请检查密钥、地域及模型权限。' :
        response.status === 429 ? '调用频率或额度受限，请稍后重试。' : '请检查模型是否支持图片与 JSON 输出，以及接口配置。';
      throw new HttpError(502, `千问接口返回 ${response.status}。${hint}`);
    }
    let data;
    try { data = await response.json(); } catch { throw new HttpError(502, '千问返回了无法解析的响应，请重试。'); }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') throw new HttpError(502, '识别结果超过输出限制，请减少截图数量后重试。');
    let parsed;
    try { parsed = JSON.parse(choice?.message?.content); } catch { throw new HttpError(502, '千问未返回有效 JSON，请重新分析。'); }
    return validateAnalysis(parsed);
  };
}
