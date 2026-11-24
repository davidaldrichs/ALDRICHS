import { describe, expect, it } from 'vitest';
import { MemoryTuningProvider, normalizeValue, type TuningSetting } from '../src/platform/tuning';
import { demoTuningFor } from '../src/modules/demo-tuning';

const temp: TuningSetting = { id: 't', name: '大循环温度', type: 'number', min: 85, max: 110, step: 1, default: 105 };

describe('编码/调校', () => {
  it('数值钳制到范围', () => {
    expect(normalizeValue(temp, 70)).toBe(85);
    expect(normalizeValue(temp, 200)).toBe(110);
    expect(normalizeValue(temp, 92)).toBe(92);
  });

  it('开关规整为布尔', () => {
    expect(normalizeValue({ id: 'x', name: 'x', type: 'toggle', default: false }, 1 as never)).toBe(true);
  });

  it('内存 provider 读写与恢复默认', () => {
    const p = new MemoryTuningProvider([temp]);
    expect(p.get('t')).toBe(105);
    p.set('t', 90);
    expect(p.get('t')).toBe(90);
    p.set('t', 999); // 超范围 → 钳制
    expect(p.get('t')).toBe(110);
    p.reset('t');
    expect(p.get('t')).toBe(105);
  });

  it('演示调校含大循环温度，且范围安全(85–110)', () => {
    const p = demoTuningFor('mini-r');
    const s = p.list().find((x) => x.id === 'cooling.large_circulation_temp')!;
    expect(s.min).toBe(85);
    expect(s.max).toBe(110);
    expect(p.get('cooling.large_circulation_temp')).toBe(105);
  });

  it('各品牌调校相互独立', () => {
    const a = demoTuningFor('mini-r');
    a.set('cooling.large_circulation_temp', 88);
    const b = demoTuningFor('mercedes');
    expect(b.get('cooling.large_circulation_temp')).toBe(105);
  });
});
