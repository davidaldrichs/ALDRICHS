import type { AiClient } from './ai-tuning';
import { desktop } from '../transport/desktop-api';

/**
 * 通用 HTTP AI 客户端,支持两类接口:
 *  - 'openai'：OpenAI 兼容（/chat/completions）,适配大多数服务和本地模型
 *  - 'anthropic'：Anthropic Messages API
 * key 由用户自己填。桌面(Electron)下走主进程转发,避免 CORS、也不把 key 暴露在页面网络里。
 */
export type AiProvider = 'openai' | 'anthropic';

export interface AiHttpConfig {
  provider: AiProvider;
  /** 基础地址,如 https://api.openai.com/v1 或 https://api.anthropic.com */
  endpoint: string;
  apiKey: string;
  model: string;
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const d = desktop() as unknown as { aiFetch?: (u: string, h: Record<string, string>, b: string) => Promise<string> } | undefined;
  const payload = JSON.stringify(body);
  if (d?.aiFetch) {
    return JSON.parse(await d.aiFetch(url, headers, payload));
  }
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
  if (!res.ok) throw new Error(`AI 接口返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export function httpAiClient(cfg: AiHttpConfig): AiClient {
  const base = cfg.endpoint.replace(/\/+$/, '');
  return {
    async complete({ system, user }) {
      if (cfg.provider === 'anthropic') {
        const data = (await post(
          `${base}/v1/messages`,
          { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
          { model: cfg.model, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] },
        )) as { content?: Array<{ text?: string }> };
        return data.content?.[0]?.text ?? '';
      }
      const data = (await post(
        `${base}/chat/completions`,
        { authorization: `Bearer ${cfg.apiKey}` },
        {
          model: cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,
        },
      )) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? '';
    },
  };
}
