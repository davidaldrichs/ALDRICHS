import type { SecurityAccessIO } from './security-access';
import type { SeedKeyAlgorithm } from './seedkey';

/**
 * 一台模拟的 UDS ECU,真实回应 10 / 27 / 31 / 34 / 35 / 36 / 37 / 11 / 23。
 * 供演示模式和测试用,让 UdsClient / UdsFlashProvider 跑真实的 UDS 流程(不是内存快捷方式)。
 *
 * 行为贴近真车:
 *  - 未进编程会话 → 安全/下载相关服务回 0x22
 *  - 未解锁 → 下载/上传回 0x33
 *  - seed/key 错误累计 3 次后锁定(0x37),延时过后计数清零
 *  - 下载前必须先擦除对应区;传输块计数必须连续,否则 0x73
 *  - 标定区末尾 4 字节是校验和,finalize 例程会重算
 */
export interface UdsSimOptions {
  secret: SeedKeyAlgorithm;
  seedLen?: number;
  requestLevel?: number;
  sendLevel?: number;
  region: { address: number; size: number };
  eraseRoutineId?: number;
  checksumRoutineId?: number;
  maxBlock?: number;
}

function makeImage(size: number): Uint8Array {
  const img = new Uint8Array(size);
  let x = 0x1234567;
  for (let i = 0; i < size - 4; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    img[i] = x >>> 24;
  }
  writeChecksum(img);
  return img;
}
function sumOf(img: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < img.length - 4; i++) s = (s + img[i]) >>> 0;
  return s;
}
function writeChecksum(img: Uint8Array): void {
  new DataView(img.buffer, img.byteOffset, img.byteLength).setUint32(img.length - 4, sumOf(img), true);
}
export function imageChecksumOk(img: Uint8Array): boolean {
  return new DataView(img.buffer, img.byteOffset, img.byteLength).getUint32(img.length - 4, true) === sumOf(img);
}

function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}
const neg = (sid: number, nrc: number) => Uint8Array.of(0x7f, sid, nrc);

export class UdsSimEcu implements SecurityAccessIO {
  memory: Uint8Array;
  private readonly o: Required<Omit<UdsSimOptions, 'secret' | 'region' | 'eraseRoutineId' | 'checksumRoutineId'>> & UdsSimOptions;
  private session = 0x01;
  private unlocked = false;
  private seed: Uint8Array | null = null;
  private failures = 0;
  private lockedUntil = 0;
  private erased = false;
  private transfer: { mode: 'read' | 'write'; addr: number; size: number; off: number; bsc: number } | null = null;

  constructor(opts: UdsSimOptions) {
    this.o = { seedLen: 4, requestLevel: 0x01, sendLevel: 0x02, maxBlock: 256, ...opts };
    this.memory = makeImage(opts.region.size);
  }

  async request(hex: string): Promise<Uint8Array> {
    const b = hexToBytes(hex);
    const sid = b[0];
    switch (sid) {
      case 0x10: // 会话
        this.session = b[1];
        return Uint8Array.of(0x50, b[1], 0x00, 0x32, 0x01, 0xf4);
      case 0x11: // 复位
        this.session = 0x01;
        this.unlocked = false;
        this.transfer = null;
        return Uint8Array.of(0x51, b[1] ?? 0x01);
      case 0x27:
        return this.security(b);
      case 0x31:
        return this.routine(b);
      case 0x34:
        return this.requestTransfer(b, 'write');
      case 0x35:
        return this.requestTransfer(b, 'read');
      case 0x36:
        return this.transferData(b);
      case 0x37:
        this.transfer = null;
        return Uint8Array.of(0x77);
      default:
        return neg(sid, 0x11);
    }
  }

  private security(b: number[]): Uint8Array {
    if (this.session < 0x02) return neg(0x27, 0x22); // 需先进编程会话
    const level = b[1];
    if (level === this.o.requestLevel) {
      this.seed = Uint8Array.from({ length: this.o.seedLen ?? 4 }, () => (Math.random() * 256) | 0);
      return Uint8Array.of(0x67, level, ...this.seed);
    }
    if (level === this.o.sendLevel) {
      if (Date.now() < this.lockedUntil) return neg(0x27, 0x37);
      if (this.failures >= 3) this.failures = 0;
      if (!this.seed) return neg(0x27, 0x24);
      const expected = this.o.secret.compute(this.seed);
      const got = b.slice(2);
      if (got.length === expected.length && got.every((x, i) => x === expected[i])) {
        this.unlocked = true;
        this.failures = 0;
        return Uint8Array.of(0x67, level);
      }
      if (++this.failures >= 3) this.lockedUntil = Date.now() + 40;
      return neg(0x27, 0x35);
    }
    return neg(0x27, 0x12);
  }

  private routine(b: number[]): Uint8Array {
    if (!this.unlocked) return neg(0x31, 0x33);
    const rid = (b[2] << 8) | b[3];
    if (this.o.eraseRoutineId !== undefined && rid === this.o.eraseRoutineId) {
      this.memory.fill(0xff);
      this.erased = true;
      return Uint8Array.of(0x71, 0x01, b[2], b[3]);
    }
    if (this.o.checksumRoutineId !== undefined && rid === this.o.checksumRoutineId) {
      writeChecksum(this.memory);
      return Uint8Array.of(0x71, 0x01, b[2], b[3], 0x00); // 0x00 = 校验通过
    }
    return neg(0x31, 0x31);
  }

  private requestTransfer(b: number[], mode: 'read' | 'write'): Uint8Array {
    const sid = mode === 'write' ? 0x34 : 0x35;
    if (!this.unlocked) return neg(sid, 0x33);
    const alfid = b[2];
    const aLen = alfid & 0x0f;
    const lLen = (alfid >> 4) & 0x0f;
    let addr = 0;
    for (let i = 0; i < aLen; i++) addr = addr * 256 + b[3 + i];
    let size = 0;
    for (let i = 0; i < lLen; i++) size = size * 256 + b[3 + aLen + i];
    if (addr !== this.o.region.address || size !== this.o.region.size) return neg(sid, 0x31);
    if (mode === 'write' && this.o.eraseRoutineId !== undefined && !this.erased) return neg(sid, 0x22); // 未擦除
    this.transfer = { mode, addr, size, off: 0, bsc: 1 };
    const max = this.o.maxBlock ?? 256;
    // 响应: 74/75 <lenFmt=0x20> <maxBlock+2 的两字节>
    const withOverhead = max + 2;
    return Uint8Array.of(sid + 0x40, 0x20, (withOverhead >> 8) & 0xff, withOverhead & 0xff);
  }

  private transferData(b: number[]): Uint8Array {
    if (!this.transfer) return neg(0x36, 0x24);
    const bsc = b[1];
    if (bsc !== this.transfer.bsc) return neg(0x36, 0x73); // 块计数错误
    if (this.transfer.mode === 'write') {
      const data = b.slice(2);
      this.memory.set(data, this.transfer.off);
      this.transfer.off += data.length;
      this.transfer.bsc = (this.transfer.bsc + 1) & 0xff;
      return Uint8Array.of(0x76, bsc);
    }
    // read
    const max = this.o.maxBlock ?? 256;
    const remaining = this.transfer.size - this.transfer.off;
    const n = Math.min(max, remaining);
    const chunk = this.memory.subarray(this.transfer.off, this.transfer.off + n);
    this.transfer.off += n;
    this.transfer.bsc = (this.transfer.bsc + 1) & 0xff;
    return Uint8Array.of(0x76, bsc, ...chunk);
  }
}
