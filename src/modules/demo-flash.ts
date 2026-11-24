import type { FlashContext, FlashMemoryRegion, FlashProvider } from '../platform/vehicle-module';

/**
 * 演示模式用的模拟 ECU 刷写实现。
 * 只在“演示模式”下使用，不会和真车通讯；用来演示和测试一键备份 / 恢复的完整流程。
 * 模拟了真实 ECU 的关键行为：必须先进编程会话并通过 seed/key 才能读写，
 * 标定区末尾 4 字节是校验和（前面所有字节求和）。
 */

const CAL: FlashMemoryRegion = { name: 'CAL', address: 0x80040000, size: 64 * 1024 };
const CHUNK = 2048;

function makeFactoryImage(): Uint8Array {
  const img = new Uint8Array(CAL.size);
  let x = 0x1234567;
  for (let i = 0; i < img.length - 4; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    img[i] = x >>> 24;
  }
  writeChecksum(img);
  return img;
}

function checksumOf(img: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < img.length - 4; i++) sum = (sum + img[i]) >>> 0;
  return sum;
}

function writeChecksum(img: Uint8Array): void {
  new DataView(img.buffer, img.byteOffset, img.byteLength).setUint32(img.length - 4, checksumOf(img), true);
}

export function checksumOk(img: Uint8Array): boolean {
  return new DataView(img.buffer, img.byteOffset, img.byteLength).getUint32(img.length - 4, true) === checksumOf(img);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DemoFlashProvider implements FlashProvider {
  readonly regions = [CAL];
  /** 模拟 ECU 里的闪存，跨多次连接保留（像真车一样） */
  memory = makeFactoryImage();
  private session = false;
  private unlocked = false;

  constructor(private readonly delayMs = 8) {}

  async enterProgrammingSession(ctx: FlashContext): Promise<void> {
    ctx.report(0, '进入编程会话（模拟）…');
    await sleep(this.delayMs);
    this.session = true;
  }

  async unlock(ctx: FlashContext): Promise<void> {
    if (!this.session) throw new Error('未进入编程会话');
    ctx.report(0, '安全认证 seed/key（模拟）…');
    await sleep(this.delayMs);
    this.unlocked = true;
  }

  private assertUnlocked(): void {
    if (!this.unlocked) throw new Error('ECU 未解锁，拒绝访问闪存');
  }

  async readRegion(ctx: FlashContext, region: FlashMemoryRegion): Promise<Uint8Array> {
    this.assertUnlocked();
    const out = new Uint8Array(region.size);
    for (let off = 0; off < region.size; off += CHUNK) {
      if (ctx.cancelled()) break;
      out.set(this.memory.subarray(off, off + CHUNK), off);
      ctx.report(off / region.size, `读取 ${region.name} ${Math.round((off / region.size) * 100)}%`);
      await sleep(this.delayMs);
    }
    return out;
  }

  async validateImage(region: FlashMemoryRegion, data: Uint8Array): Promise<void> {
    if (data.length !== region.size) throw new Error(`文件大小 ${data.length} 与区域 ${region.size} 不符`);
  }

  async writeRegion(ctx: FlashContext, region: FlashMemoryRegion, data: Uint8Array): Promise<void> {
    this.assertUnlocked();
    for (let off = 0; off < region.size; off += CHUNK) {
      if (ctx.cancelled()) throw new Error('写入被中断——ECU 程序不完整，请立即重新恢复备份');
      this.memory.set(data.subarray(off, off + CHUNK), off);
      ctx.report(0.4 + (off / region.size) * 0.5, `写入 ${region.name} ${Math.round((off / region.size) * 100)}%`);
      await sleep(this.delayMs);
    }
  }

  async finalizeChecksum(): Promise<void> {
    this.assertUnlocked();
    writeChecksum(this.memory);
  }

  async reset(): Promise<void> {
    this.session = false;
    this.unlocked = false;
    await sleep(this.delayMs);
  }
}

/** 演示模式共用一个模拟 ECU，备份和恢复看到的是同一块“闪存” */
export const demoFlash = new DemoFlashProvider();
