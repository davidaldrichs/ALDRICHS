import { describe, expect, it } from 'vitest';
import { getModule } from '../src/modules/registry';
import { demoFlashFor } from '../src/modules/demo-flash';
import type { FlashContext } from '../src/platform/vehicle-module';

describe('宝马模块', () => {
  it('三个系列 E/F/G，含 N54/B58', () => {
    const m = getModule('bmw')!;
    expect(m.variants.map((v) => v.id)).toEqual(['e', 'f', 'g']);
    expect(m.variants[0].subModels.map((s) => s.code)).toContain('N54');
    expect(m.variants[2].subModels.map((s) => s.code)).toContain('B58');
  });
  it('VIN 识别宝马（WBA 等）', () => {
    const m = getModule('bmw')!;
    expect(m.analyzeVin!('WBA8E9C50GK123456').belongsToModule).toBe(true);
    expect(m.analyzeVin!('WMWMF7C5XBTX98765').belongsToModule).toBe(false);
  });
  it('解锁标为不支持（宝马私有/RSA）', () => {
    expect(getModule('bmw')!.features.find((f) => f.name.includes('解锁'))!.status).toBe('unsupported');
  });
  it('演示一键解锁如实失败（需逆向）', async () => {
    const ctx = (): FlashContext => ({ elm: {} as never, obd: {} as never, report: () => {}, cancelled: () => false });
    const ecu = demoFlashFor('bmw');
    await ecu.enterProgrammingSession(ctx());
    const r = await ecu.probeUnlock!(ctx());
    expect(r.unlocked).toBe(false);
    expect(r.reason).toMatch(/逆向/);
  });
});
