/**
 * 奔驰 / 戴姆勒（Mercedes-Benz / Daimler）seed/key 算法。
 *
 * 结构（三个变体通用）：
 *   seed 必须 8 字节，拆成两个大端 32 位：seedA(前4)、seedB(后4)
 *   i1 = kA0 * seedA + kC0
 *   i2 = kA1 * seedB + kC1
 *   key = low32( i1 ^ i2 ^ K )    // K = 每台车的 4 字节私钥（crypto key）
 *   输出 key 为 4 字节大端
 *
 * 变体差异：
 *   standard : kA0=kA1=1103515245, kC0=kC1=12345（即经典 glibc LCG 常量）；K 来自参数 "K"
 *   refG     : kA0=3040238857, kA1=4126034881, kC0=2094854071, kC1=3555108353；K 来自 "K_refG"
 *   mod      : kA/kC 为每台车参数；K 来自 "K"
 *
 * 移植自 jglim/UnlockECU（MIT，算法为逆向重实现）。
 * https://github.com/jglim/UnlockECU
 *
 * ⚠️ 没有公开的奔驰 seed/key 测试向量，这里只做了“自洽/反推”验证（见 tests/daimler.test.ts），
 *    未在真车上核对过。真用前请拿一对已知 seed/key 校准。每台车的 K 值要从该 ECU 的定义数据里取。
 */

import type { SeedKeyAlgorithm } from './seedkey';

export type DaimlerVariant = 'standard' | 'refG' | 'mod';

export interface DaimlerParams {
  /** 4 字节私钥（crypto key），十六进制或字节 */
  K: Uint8Array;
  /** mod 变体专用 */
  kA?: bigint;
  kC?: bigint;
}

const u32be = (b: Uint8Array, o: number): bigint =>
  BigInt(((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);

interface Consts {
  kA0: bigint;
  kC0: bigint;
  kA1: bigint;
  kC1: bigint;
}

function constsFor(variant: DaimlerVariant, p: DaimlerParams): Consts {
  switch (variant) {
    case 'standard':
      return { kA0: 1103515245n, kC0: 12345n, kA1: 1103515245n, kC1: 12345n };
    case 'refG':
      return { kA0: 3040238857n, kC0: 2094854071n, kA1: 4126034881n, kC1: 3555108353n };
    case 'mod':
      if (p.kA === undefined || p.kC === undefined) throw new Error('mod 变体需要 kA、kC 参数');
      return { kA0: p.kA, kC0: p.kC, kA1: p.kA, kC1: p.kC };
  }
}

export function daimlerSeedToKey(variant: DaimlerVariant, p: DaimlerParams, seed: Uint8Array): Uint8Array {
  if (seed.length !== 8) throw new Error('奔驰算法需要 8 字节 seed');
  if (p.K.length < 4) throw new Error('K（私钥）至少 4 字节');
  const { kA0, kC0, kA1, kC1 } = constsFor(variant, p);
  const seedA = u32be(seed, 0);
  const seedB = u32be(seed, 4);
  const k = u32be(p.K, 0); // 只用前 4 字节
  const i1 = kA0 * seedA + kC0;
  const i2 = kA1 * seedB + kC1;
  const out = BigInt.asUintN(32, i1 ^ i2 ^ k);
  return Uint8Array.of(
    Number((out >> 24n) & 0xffn),
    Number((out >> 16n) & 0xffn),
    Number((out >> 8n) & 0xffn),
    Number(out & 0xffn),
  );
}

/**
 * 从一对已知 (seed, key) 反推出该 ECU 的 K（私钥）。
 * 这是奔驰算法的固有弱点：拿到一对就能还原 K，之后任意 seed 都能算 key。
 */
export function daimlerRecoverKey(variant: DaimlerVariant, seed: Uint8Array, key: Uint8Array, p: Omit<DaimlerParams, 'K'> = {}): Uint8Array {
  if (seed.length !== 8 || key.length !== 4) throw new Error('需要 8 字节 seed 和 4 字节 key');
  const { kA0, kC0, kA1, kC1 } = constsFor(variant, { ...p, K: new Uint8Array(4) });
  const i1 = BigInt.asUintN(32, kA0 * u32be(seed, 0) + kC0);
  const i2 = BigInt.asUintN(32, kA1 * u32be(seed, 4) + kC1);
  const kRec = BigInt.asUintN(32, u32be(key, 0) ^ i1 ^ i2);
  return Uint8Array.of(Number((kRec >> 24n) & 0xffn), Number((kRec >> 16n) & 0xffn), Number((kRec >> 8n) & 0xffn), Number(kRec & 0xffn));
}

/** 包装成解锁引擎用的算法（需先知道这台车的 K） */
export function daimlerAlgorithm(id: string, label: string, variant: DaimlerVariant, p: DaimlerParams): SeedKeyAlgorithm {
  return { id, label, compute: (seed) => daimlerSeedToKey(variant, p, seed) };
}
