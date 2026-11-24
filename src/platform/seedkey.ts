/**
 * seed/key 密钥算法库。
 *
 * 每个算法是一个纯函数 seed(字节) -> key(字节)。一键解锁会按顺序逐个尝试，命中即停。
 *
 * ⚠️ 这里收录的都是**通用/公开**的算法族（恒等、取反、异或常量、加常量、
 *    移位、字节交换等），不是任何厂家的私有密钥。某款具体 ECU 的真实算法，
 *    需要在台架上从 ECU 固件或官方软件里逆向得到，逆出来后作为一条新算法
 *    加到 GENERIC 列表（或各车型模块自带的列表）即可，一键解锁就能用上。
 */

export interface SeedKeyAlgorithm {
  id: string;
  label: string;
  /** seed -> key；若该算法不适用于这个 seed 长度，抛错即可（引擎会跳过） */
  compute(seed: Uint8Array): Uint8Array;
}

export function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
}

/* 4 字节大端 <-> uint32 */
function u32(seed: Uint8Array): number {
  if (seed.length !== 4) throw new Error('需要 4 字节 seed');
  return ((seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3]) >>> 0;
}
function fromU32(x: number): Uint8Array {
  return Uint8Array.of((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
}
const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;

/** 一些通用算法族。真实 ECU 的算法逆出来后按同样格式加进来。 */
export const GENERIC_ALGORITHMS: SeedKeyAlgorithm[] = [
  { id: 'identity', label: 'key = seed', compute: (s) => Uint8Array.from(s) },
  { id: 'not', label: 'key = ~seed', compute: (s) => s.map((b) => ~b & 0xff) },
  { id: 'bswap', label: '字节反转', compute: (s) => Uint8Array.from([...s].reverse()) },
  { id: 'add-1', label: 'key = seed + 1', compute: (s) => fromU32((u32(s) + 1) >>> 0) },
  { id: 'xor-ff', label: 'key = seed ^ 0xFFFFFFFF', compute: (s) => fromU32(u32(s) ^ 0xffffffff) },
  { id: 'xor-5a', label: 'key = seed ^ 0x5A5A5A5A', compute: (s) => fromU32(u32(s) ^ 0x5a5a5a5a) },
  { id: 'rotl5-xor5a', label: '(seed ^ 0x5A5A5A5A) <<< 5', compute: (s) => fromU32(rotl(u32(s) ^ 0x5a5a5a5a, 5)) },
  { id: 'sub-from-c', label: 'key = 0xC541A9B3 - seed', compute: (s) => fromU32((0xc541a9b3 - u32(s)) >>> 0) },
];

/** 按 id 取算法 */
export function algorithmById(id: string, list: SeedKeyAlgorithm[] = GENERIC_ALGORITHMS): SeedKeyAlgorithm | undefined {
  return list.find((a) => a.id === id);
}
