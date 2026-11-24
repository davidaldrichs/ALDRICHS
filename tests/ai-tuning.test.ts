import { describe, expect, it } from 'vitest';
import { proposeTuning, buildPrompt, AiTuningError, type AiClient } from '../src/platform/ai-tuning';
import { MemoryTuningProvider, type TuningSetting } from '../src/platform/tuning';

const settings: TuningSetting[] = [
  { id: 'cooling.temp', name: '大循环温度', type: 'number', unit: '°C', min: 85, max: 110, step: 1, default: 105 },
  { id: 'feature.drl', name: '日行灯', type: 'toggle', default: false },
];
const mk = () => new MemoryTuningProvider(settings.map((s) => ({ ...s })));
const ai = (text: string): AiClient => ({ complete: async () => text });

describe('AI 调校顾问（护栏）', () => {
  it('超出范围的建议被强制钳到安全值', async () => {
    const r = await proposeTuning(mk(), '大幅降温', ai('{"changes":[{"id":"cooling.temp","value":40,"rationale":"更凉"}],"notes":"ok"}'));
    expect(r.proposals[0].to).toBe(85); // 40 → 钳到 min 85
    expect(r.proposals[0].clamped).toBe(true);
  });

  it('清单之外的参数一律忽略（AI 不能改没定义的东西）', async () => {
    const r = await proposeTuning(mk(), 'x', ai('{"changes":[{"id":"boost.map","value":2.5,"rationale":"加压"},{"id":"cooling.temp","value":92}],"notes":""}'));
    expect(r.proposals.map((p) => p.id)).toEqual(['cooling.temp']);
    expect(r.proposals[0].to).toBe(92);
    expect(r.proposals[0].clamped).toBe(false);
  });

  it('开关建议规整为布尔', async () => {
    const r = await proposeTuning(mk(), 'x', ai('{"changes":[{"id":"feature.drl","value":"true","rationale":"开"}]}'));
    expect(r.proposals[0].to).toBe(true);
  });

  it('没有变化的项不列出', async () => {
    const r = await proposeTuning(mk(), 'x', ai('{"changes":[{"id":"cooling.temp","value":105}]}')); // 等于当前值
    expect(r.proposals).toHaveLength(0);
  });

  it('非 JSON 输出报友好错误', async () => {
    await expect(proposeTuning(mk(), 'x', ai('抱歉我帮不了'))).rejects.toBeInstanceOf(AiTuningError);
  });

  it('空目标被拒绝', async () => {
    await expect(proposeTuning(mk(), '  ', ai('{}'))).rejects.toThrow(/目标/);
  });

  it('prompt 包含范围并要求只回 JSON', () => {
    const p = buildPrompt(settings, () => 105, '提升动力');
    expect(p.user).toMatch(/85~110/);
    expect(p.system).toMatch(/JSON/);
    expect(p.system).toMatch(/范围|最小|最大/);
  });
});
