/**
 * 大众 / 奥迪（VAG）SA2 seed/key 算法。
 *
 * SA2 不是固定公式，而是一段“字节码脚本”：每款 ECU 把自己的脚本存在刷写数据
 * （FRF/ODX 容器）里，用它处理 4 字节 seed 得到 4 字节 key。这里实现这段字节码的
 * 解释器——这是开源里**真实、可验证**的解锁算法（见下方两个测试向量）。
 *
 * 移植自 bri3d/sa2_seed_key（MIT 许可），操作码与其一致。
 * https://github.com/bri3d/sa2_seed_key
 *
 * 用法：从某款 VAG ECU 的刷写数据里取出它的 SA2 脚本，调用 sa2SeedToKey(script, seed)。
 */

const MASK = 0xffffffff;
const u32 = (n: number): number => n >>> 0;

/** 执行 SA2 脚本，seed 和返回值都是 32 位无符号整数 */
export function sa2Execute(script: readonly number[], seed: number): number {
  let reg = u32(seed);
  let carry = 0;
  let ip = 0;
  const loopStart: number[] = [];
  const loopCount: number[] = [];
  const imm = (i: number) => u32((script[i] << 24) | (script[i + 1] << 16) | (script[i + 2] << 8) | script[i + 3]);

  let guard = 0;
  while (ip < script.length) {
    if (++guard > 1_000_000) throw new Error('SA2 脚本执行超限（可能有死循环）');
    const op = script[ip];
    switch (op) {
      case 0x81: // RSL 循环左移 1 位
        carry = (reg >>> 31) & 1;
        reg = u32((reg << 1) | carry);
        ip += 1;
        break;
      case 0x82: // RSR 循环右移 1 位
        carry = reg & 1;
        reg = u32((reg >>> 1) | (carry << 31));
        ip += 1;
        break;
      case 0x93: {
        // ADD imm32
        const s = reg + imm(ip + 1);
        carry = s > MASK ? 1 : 0;
        reg = u32(s & MASK);
        ip += 5;
        break;
      }
      case 0x84: {
        // SUB imm32
        const s = reg - imm(ip + 1);
        carry = s < 0 ? 1 : 0;
        reg = u32(s & MASK);
        ip += 5;
        break;
      }
      case 0x87: // EOR imm32（不改 carry）
        reg = u32(reg ^ imm(ip + 1));
        ip += 5;
        break;
      case 0x68: // FOR n：循环体执行 n 次（n=0 也执行一次）
        loopStart.push(ip + 2);
        loopCount.push(script[ip + 1] - 1);
        ip += 2;
        break;
      case 0x49: // NEXT：计数>0 则回到循环体，否则退出循环
        if (loopCount.length === 0) throw new Error('SA2：NEXT 没有匹配的 FOR');
        if (loopCount[loopCount.length - 1] > 0) {
          loopCount[loopCount.length - 1] -= 1;
          ip = loopStart[loopStart.length - 1];
        } else {
          loopStart.pop();
          loopCount.pop();
          ip += 1;
        }
        break;
      case 0x4a: // BCC off：carry==0 向前跳
        ip += carry === 0 ? script[ip + 1] + 2 : 2;
        break;
      case 0x6b: // BRA off：无条件向前跳
        ip += script[ip + 1] + 2;
        break;
      case 0x4c: // FINISH 结束标记
        ip += 1;
        break;
      default:
        throw new Error(`SA2：未知操作码 0x${op.toString(16)}（位置 ${ip}）`);
    }
  }
  return reg;
}

/** 字节数组形式：seed/key 都按大端 4 字节 */
export function sa2SeedToKey(script: readonly number[], seed: Uint8Array): Uint8Array {
  if (seed.length !== 4) throw new Error('SA2 需要 4 字节 seed');
  const s = u32((seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3]);
  const k = sa2Execute(script, s);
  return Uint8Array.of((k >>> 24) & 0xff, (k >>> 16) & 0xff, (k >>> 8) & 0xff, k & 0xff);
}

import type { SeedKeyAlgorithm } from './seedkey';

/** 把某款 ECU 的 SA2 脚本包装成一个 seed/key 算法，供解锁引擎使用 */
export function sa2Algorithm(id: string, label: string, script: readonly number[]): SeedKeyAlgorithm {
  return { id, label, compute: (seed) => sa2SeedToKey(script, seed) };
}
