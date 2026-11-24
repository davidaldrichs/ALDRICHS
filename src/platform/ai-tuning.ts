import { normalizeValue, type TuningProvider, type TuningSetting } from './tuning';

/**
 * AI 调校顾问（有安全护栏）。
 *
 * 设计原则——AI 只当参谋,不当手:
 *  1. AI 只在**已定义、有上下限**的参数上提建议,不接触原始 map（没有 map 定义就是瞎写,危险）。
 *  2. AI 给的每个值,代码里强制 normalizeValue 钳到该参数的 min/max,AI 超不出安全范围。
 *  3. 返回“从→到 + 理由”的改动清单,由人逐项确认才生效,原厂备份始终保留,绝不自动刷写。
 *
 * 接入任意 API：实现 AiClient.complete 即可（Anthropic / OpenAI 兼容 / 本地模型都行）。
 */

export interface AiClient {
  complete(req: { system: string; user: string }): Promise<string>;
}

export interface TuningProposal {
  id: string;
  name: string;
  from: number | boolean;
  to: number | boolean;
  /** AI 给的值超出了安全范围,被钳制过 */
  clamped: boolean;
  rationale: string;
}

export interface TuningAdvice {
  proposals: TuningProposal[];
  notes: string;
}

export class AiTuningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiTuningError';
  }
}

function describeSetting(s: TuningSetting, current: number | boolean): string {
  if (s.type === 'toggle') return `- ${s.id}（${s.name}）: 开关,当前=${current ? '开' : '关'}${s.note ? `。${s.note}` : ''}`;
  return `- ${s.id}（${s.name}）: 数值 ${s.min}~${s.max}${s.unit ?? ''},步长 ${s.step ?? 1},原厂=${String(s.default)},当前=${String(current)}${s.note ? `。${s.note}` : ''}`;
}

export function buildPrompt(settings: TuningSetting[], get: (id: string) => number | boolean, goal: string): { system: string; user: string } {
  const system = [
    '你是汽车 ECU 调校顾问。只能在给出的参数清单内、各自范围内给建议,偏保守,安全第一。',
    '不要建议任何清单之外的改动。不得越过每个参数的最小/最大值。',
    '只输出一个 JSON 对象,不要多余文字,格式:',
    '{"changes":[{"id":"参数id","value":数字或true/false,"rationale":"一句中文理由"}],"notes":"整体说明与风险提示"}',
  ].join('\n');
  const user = [
    `调校目标: ${goal}`,
    '',
    '可调参数:',
    ...settings.map((s) => describeSetting(s, get(s.id))),
    '',
    '请只返回 JSON。',
  ].join('\n');
  return { system, user };
}

/** 从模型输出里抠出第一个 JSON 对象 */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiTuningError('AI 没有返回有效的 JSON');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AiTuningError('AI 返回的 JSON 无法解析');
  }
}

export async function proposeTuning(provider: TuningProvider, goal: string, ai: AiClient): Promise<TuningAdvice> {
  if (!goal.trim()) throw new AiTuningError('请先填写调校目标');
  const settings = provider.list();
  const prompt = buildPrompt(settings, (id) => provider.get(id), goal);
  const raw = await ai.complete(prompt);
  const parsed = extractJson(raw) as { changes?: Array<{ id?: string; value?: unknown; rationale?: string }>; notes?: string };
  const proposals: TuningProposal[] = [];
  for (const c of parsed.changes ?? []) {
    const s = settings.find((x) => x.id === c.id);
    if (!s) continue; // 清单外的改动一律忽略
    const from = provider.get(s.id);
    let desired: number | boolean;
    if (s.type === 'toggle') desired = c.value === true || c.value === 'true' || c.value === 1;
    else {
      const n = Number(c.value);
      if (!Number.isFinite(n)) continue;
      desired = n;
    }
    const to = normalizeValue(s, desired); // 强制钳到安全范围
    const clamped = s.type === 'number' && Number(to) !== Number(desired);
    if (to === from) continue; // 没变化的不列
    proposals.push({ id: s.id, name: s.name, from, to, clamped, rationale: String(c.rationale ?? '').slice(0, 200) });
  }
  return { proposals, notes: String(parsed.notes ?? '').slice(0, 800) };
}
