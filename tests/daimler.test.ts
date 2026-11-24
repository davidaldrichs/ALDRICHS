import { describe, expect, it } from 'vitest';
import { daimlerSeedToKey, daimlerRecoverKey, daimlerAlgorithm, type DaimlerVariant } from '../src/platform/daimler';

// 没有公开的奔驰官方测试向量，这里做自洽验证：
//  1) 算法确定性
//  2) 反推特性：给定 K 算出 key 后，能从 (seed,key) 还原出同一个 K（文档描述的弱点）
//  3) 一个锁定快照值，防止字节序/溢出处理回归
const seed = Uint8Array.of(0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88);
const K = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
const variants: DaimlerVariant[] = ['standard', 'refG', 'mod'];
const modParams = { kA: 1103515245n, kC: 12345n };

describe('奔驰 / 戴姆勒 seed/key', () => {
  it('确定性', () => {
    const a = daimlerSeedToKey('standard', { K }, seed);
    const b = daimlerSeedToKey('standard', { K }, seed);
    expect([...a]).toEqual([...b]);
    expect(a.length).toBe(4);
  });

  it('反推特性：从 (seed,key) 能还原出 K', () => {
    for (const v of variants) {
      const p = v === 'mod' ? { K, ...modParams } : { K };
      const key = daimlerSeedToKey(v, p, seed);
      const kRec = daimlerRecoverKey(v, seed, key, v === 'mod' ? modParams : {});
      expect([...kRec]).toEqual([...K]);
    }
  });

  it('不同变体给出不同结果', () => {
    const s = daimlerSeedToKey('standard', { K }, seed);
    const r = daimlerSeedToKey('refG', { K }, seed);
    expect([...s]).not.toEqual([...r]);
  });

  it('快照（锁定实现，防回归）', () => {
    // standard: i1=1103515245*0x11223344+12345, i2=1103515245*0x55667788+12345, key=low32(i1^i2^0xDEADBEEF)
    const key = daimlerSeedToKey('standard', { K }, seed);
    expect([...key].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(snapshot('standard'));
  });

  it('包装成算法可被解锁引擎调用', () => {
    const algo = daimlerAlgorithm('mb-c207', '奔驰（示例 K）', 'standard', { K });
    expect(algo.compute(seed).length).toBe(4);
  });

  it('输入长度校验', () => {
    expect(() => daimlerSeedToKey('standard', { K }, Uint8Array.of(1, 2, 3, 4))).toThrow(/8 字节/);
    expect(() => daimlerSeedToKey('standard', { K: Uint8Array.of(1, 2) }, seed)).toThrow(/至少 4/);
    expect(() => daimlerSeedToKey('mod', { K }, seed)).toThrow(/kA、kC/);
  });
});

// 独立用 BigInt 重算一遍作为期望值（与实现同公式，但手写一遍以捕捉字节序/移位错误）
function snapshot(_v: 'standard'): string {
  const be = (b: Uint8Array, o: number) => BigInt(((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  const sA = be(seed, 0), sB = be(seed, 4), k = be(K, 0);
  const out = BigInt.asUintN(32, (1103515245n * sA + 12345n) ^ (1103515245n * sB + 12345n) ^ k);
  return out.toString(16).padStart(8, '0');
}

import { getModule } from '../src/modules/registry';
import { demoFlashFor } from '../src/modules/demo-flash';
import type { FlashContext } from '../src/platform/vehicle-module';

describe('奔驰车型模块', () => {
  it('已注册为可用模块，含柴油(OM)和汽油(M)两类', () => {
    const m = getModule('mercedes')!;
    expect(m.status).toBe('available');
    expect(m.variants.map((v) => v.id)).toEqual(['diesel', 'petrol']);
    expect(m.variants[0].subModels.map((s) => s.code)).toContain('OM651');
    expect(m.variants[1].subModels.map((s) => s.code)).toContain('M274');
  });

  it('VIN 识别奔驰', () => {
    const m = getModule('mercedes')!;
    expect(m.analyzeVin!('WDD2050011R123456').belongsToModule).toBe(true);
    expect(m.analyzeVin!('WMWMF7C5XBTX98765').belongsToModule).toBe(false);
  });

  it('演示模式用真实 Daimler 算法一键解锁模拟奔驰 ECU', async () => {
    const ctx = (): FlashContext => ({ elm: {} as never, obd: {} as never, report: () => {}, cancelled: () => false });
    const ecu = demoFlashFor('mercedes');
    await ecu.enterProgrammingSession(ctx());
    const res = await ecu.probeUnlock!(ctx());
    expect(res.unlocked).toBe(true);
    expect(res.algorithm?.id).toBe('mb-daimler-demo');
  });

  it('MINI 和奔驰用各自的演示 ECU', () => {
    expect(demoFlashFor('mercedes')).not.toBe(demoFlashFor('mini-r'));
  });
});
