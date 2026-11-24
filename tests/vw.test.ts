import { describe, expect, it } from 'vitest';
import { getModule } from '../src/modules/registry';
import { demoFlashFor } from '../src/modules/demo-flash';
import type { FlashContext } from '../src/platform/vehicle-module';

describe('大众（VAG）模块', () => {
  it('汽油/柴油两变体，含 EA888 / EA288', () => {
    const m = getModule('vw')!;
    expect(m.variants.map((v) => v.id)).toEqual(['petrol', 'diesel']);
    expect(m.variants[0].subModels.map((s) => s.code)).toContain('EA888');
    expect(m.variants[1].subModels.map((s) => s.code)).toContain('EA288');
  });

  it('解锁功能标为“可用”（SA2 已验证）', () => {
    const f = getModule('vw')!.features.find((x) => x.name.includes('解锁'))!;
    expect(f.status).toBe('ready');
  });

  it('VIN 识别 VAG（WVW/WAU/TMB）', () => {
    const m = getModule('vw')!;
    expect(m.analyzeVin!('WVWZZZ1KZAW123456').belongsToModule).toBe(true);
    expect(m.analyzeVin!('WAUZZZ8K9BA123456').belongsToModule).toBe(true);
    expect(m.analyzeVin!('WMWMF7C5XBTX98765').belongsToModule).toBe(false);
  });

  it('演示模式用真实 SA2 算法一键解锁模拟 VAG ECU', async () => {
    const ctx = (): FlashContext => ({ elm: {} as never, obd: {} as never, report: () => {}, cancelled: () => false });
    const ecu = demoFlashFor('vw');
    await ecu.enterProgrammingSession(ctx());
    const res = await ecu.probeUnlock!(ctx());
    expect(res.unlocked).toBe(true);
    expect(res.algorithm?.id).toBe('vag-sa2-demo');
  });
});
