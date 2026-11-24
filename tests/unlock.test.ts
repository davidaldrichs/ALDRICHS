import { describe, expect, it } from 'vitest';
import { securityAccess, type SecurityAccessIO } from '../src/platform/security-access';
import { GENERIC_ALGORITHMS, algorithmById, bytesToHex } from '../src/platform/seedkey';
import { DemoFlashProvider, SimSeedKeyEcu } from '../src/modules/demo-flash';
import type { FlashContext } from '../src/platform/vehicle-module';

const opts = (over = {}) => ({
  requestLevel: 0x01,
  sendLevel: 0x02,
  algorithms: GENERIC_ALGORITHMS,
  maxAttempts: GENERIC_ALGORITHMS.length,
  lockoutWaitMs: 60,
  ...over,
});

describe('seed/key 算法库', () => {
  it('每个算法是确定性的纯函数', () => {
    const seed = Uint8Array.of(0x12, 0x34, 0x56, 0x78);
    for (const a of GENERIC_ALGORITHMS) {
      expect(bytesToHex(a.compute(seed))).toBe(bytesToHex(a.compute(seed)));
      expect(a.compute(seed).length).toBe(4);
    }
  });
});

describe('security access 引擎', () => {
  it('能试出 ECU 用的算法并解锁', async () => {
    const ecu = new SimSeedKeyEcu(algorithmById('rotl5-xor5a')!);
    const r = await securityAccess(ecu, opts());
    expect(r.unlocked).toBe(true);
    expect(r.algorithm?.id).toBe('rotl5-xor5a');
  });

  it('算法库里没有匹配算法时，如实报告需要逆向', async () => {
    const secret = { id: 'secret', label: 'x', compute: (s: Uint8Array) => s.map((b) => (b + 7) & 0xff) };
    const ecu = new SimSeedKeyEcu(secret);
    const r = await securityAccess(ecu, opts());
    expect(r.unlocked).toBe(false);
    expect(r.reason).toMatch(/逆向/);
  });

  it('已解锁（种子全 0）直接返回成功', async () => {
    const io: SecurityAccessIO = { request: async () => Uint8Array.of(0x67, 0x01, 0, 0, 0, 0) };
    const r = await securityAccess(io, opts());
    expect(r.unlocked).toBe(true);
    expect(r.reason).toMatch(/已处于解锁/);
  });

  it('超过尝试次数（ECU 返回 0x36）立即停止', async () => {
    const io: SecurityAccessIO = {
      request: async (hex) => (hex.startsWith('2701') ? Uint8Array.of(0x67, 0x01, 1, 2, 3, 4) : Uint8Array.of(0x7f, 0x27, 0x36)),
    };
    const r = await securityAccess(io, opts());
    expect(r.unlocked).toBe(false);
    expect(r.reason).toMatch(/锁定/);
  });

  it('maxAttempts 限制尝试次数，避免锁死 ECU', async () => {
    let keyTries = 0;
    const io: SecurityAccessIO = {
      request: async (hex) => {
        if (hex.startsWith('2701')) return Uint8Array.of(0x67, 0x01, 1, 2, 3, 4);
        keyTries++;
        return Uint8Array.of(0x7f, 0x27, 0x35); // 永远错
      },
    };
    const r = await securityAccess(io, opts({ maxAttempts: 2 }));
    expect(r.unlocked).toBe(false);
    expect(keyTries).toBe(2);
    expect(r.reason).toMatch(/已停止/);
  });

  it('遇到 0x37（需等待）会暂停后继续', async () => {
    let first = true;
    const ecu = new SimSeedKeyEcu(algorithmById('rotl5-xor5a')!);
    const io: SecurityAccessIO = {
      request: async (hex) => {
        if (hex.startsWith('2702') && first) {
          first = false;
          return Uint8Array.of(0x7f, 0x27, 0x37); // 第一次要求等待
        }
        return ecu.request(hex);
      },
    };
    const r = await securityAccess(io, opts());
    expect(r.unlocked).toBe(true);
  });
});

describe('演示 ECU 一键解锁', () => {
  const ctx = (): FlashContext => ({ elm: {} as never, obd: {} as never, report: () => {}, cancelled: () => false });
  it('probeUnlock 成功并记录算法', async () => {
    const ecu = new DemoFlashProvider(0);
    await ecu.enterProgrammingSession(ctx());
    const r = await ecu.probeUnlock(ctx());
    expect(r.unlocked).toBe(true);
    expect(r.algorithm?.id).toBe('rotl5-xor5a');
  });
  it('没进会话不能解锁', async () => {
    const ecu = new DemoFlashProvider(0);
    await expect(ecu.probeUnlock(ctx())).rejects.toThrow(/会话/);
  });
});
