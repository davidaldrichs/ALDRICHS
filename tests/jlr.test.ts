import { describe, expect, it } from 'vitest';
import { getModule } from '../src/modules/registry';
import { demoFlashFor } from '../src/modules/demo-flash';
import type { FlashContext } from '../src/platform/vehicle-module';

describe('捷豹路虎模块', () => {
  it('三个年款变体 2014/2017/2020', () => {
    const m = getModule('jlr')!;
    expect(m.variants.map((v) => v.id)).toEqual(['y2014', 'y2017', 'y2020']);
    expect(m.variants[1].subModels.map((s) => s.code)).toContain('AJ200D'); // Ingenium
  });

  it('VIN 识别（SAJ 捷豹 / SAL 路虎）', () => {
    const m = getModule('jlr')!;
    expect(m.analyzeVin!('SALGA2EF8HA123456').belongsToModule).toBe(true);
    expect(m.analyzeVin!('WDD2050011R123456').belongsToModule).toBe(false);
  });

  it('解锁功能标为“不支持”（开源无算法）', () => {
    const f = getModule('jlr')!.features.find((x) => x.name.includes('解锁'))!;
    expect(f.status).toBe('unsupported');
  });

  it('演示模式一键解锁如实失败（算法不在库里 → 需逆向）', async () => {
    const ctx = (): FlashContext => ({ elm: {} as never, obd: {} as never, report: () => {}, cancelled: () => false });
    const ecu = demoFlashFor('jlr');
    await ecu.enterProgrammingSession(ctx());
    const res = await ecu.probeUnlock(ctx());
    expect(res.unlocked).toBe(false);
    expect(res.reason).toMatch(/逆向/);
  });
});
