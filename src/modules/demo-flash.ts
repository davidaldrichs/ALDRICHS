import type { FlashContext, FlashMemoryRegion, FlashProvider } from '../platform/vehicle-module';
import { GENERIC_ALGORITHMS, algorithmById, bytesToHex, type SeedKeyAlgorithm } from '../platform/seedkey';
import { securityAccess, type SecurityAccessIO, type UnlockResult } from '../platform/security-access';

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

export interface DemoFlashConfig {
  /** 模拟 ECU 内部用的“私钥”算法 */
  secret: SeedKeyAlgorithm;
  /** 一键解锁时引擎会尝试的候选算法 */
  candidates: SeedKeyAlgorithm[];
  /** seed 字节数（MINI 示例 4；奔驰 8） */
  seedLen: number;
}

export class DemoFlashProvider implements FlashProvider {
  readonly regions = [CAL];
  /** 模拟 ECU 里的闪存，跨多次连接保留（像真车一样） */
  memory = makeFactoryImage();
  private session = false;
  private unlocked = false;
  private readonly cfg: DemoFlashConfig;

  constructor(cfg?: Partial<DemoFlashConfig>, private readonly delayMs = 8) {
    const secret = cfg?.secret ?? algorithmById('rotl5-xor5a')!;
    this.cfg = {
      secret,
      candidates: cfg?.candidates ?? GENERIC_ALGORITHMS,
      seedLen: cfg?.seedLen ?? 4,
    };
  }

  async enterProgrammingSession(ctx: FlashContext): Promise<void> {
    ctx.report(0, '进入编程会话（模拟）…');
    await sleep(this.delayMs);
    this.session = true;
  }

  async unlock(ctx: FlashContext): Promise<void> {
    const res = await this.probeUnlock(ctx);
    if (!res.unlocked) throw new Error(res.reason ?? '解锁失败');
    this.unlocked = true;
  }

  /** 一键解锁：用真实的 security access 引擎，对模拟 ECU 试候选算法 */
  async probeUnlock(ctx: FlashContext): Promise<UnlockResult> {
    if (!this.session) throw new Error('未进入编程会话');
    const ecu = new SimSeedKeyEcu(this.cfg.secret, this.cfg.seedLen);
    const res = await securityAccess(
      { request: (hex) => ecu.request(hex) },
      {
        requestLevel: 0x01,
        sendLevel: 0x02,
        algorithms: this.cfg.candidates,
        maxAttempts: this.cfg.candidates.length,
        report: (m) => ctx.report(0, m),
        lockoutWaitMs: 50,
      },
    );
    this.unlocked = res.unlocked;
    return res;
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

/**
 * 模拟一个有 seed/key 保护的 ECU，只回应 27 01 / 27 02。
 * 它内部“藏着”一个密钥算法，securityAccess 引擎要从算法库里试出同一个算法才能解锁。
 * 也模拟了真车的错误计数和锁定行为。
 */
class SimSeedKeyEcu implements SecurityAccessIO {
  private seed: Uint8Array | null = null;
  private failures = 0;
  private lockedUntil = 0;

  constructor(
    private readonly secret: SeedKeyAlgorithm,
    private readonly seedLen = 4,
  ) {}

  async request(hex: string): Promise<Uint8Array> {
    const bytes = hexToBytes(hex);
    if (bytes[0] !== 0x27) return Uint8Array.of(0x7f, bytes[0] ?? 0, 0x11);
    const level = bytes[1];
    if (level === 0x01) {
      // 请求种子（长度按 ECU 设定）
      this.seed = Uint8Array.from({ length: this.seedLen }, () => (Math.random() * 256) | 0);
      return Uint8Array.of(0x67, 0x01, ...this.seed);
    }
    if (level === 0x02) {
      // 锁定中：要求等待（真车也是这样，等延时过了才能再试）
      if (Date.now() < this.lockedUntil) return Uint8Array.of(0x7f, 0x27, 0x37);
      // 延时已过：错误计数清零，又可以再试 3 次
      if (this.failures >= 3) this.failures = 0;
      if (!this.seed) return Uint8Array.of(0x7f, 0x27, 0x24);
      const expected = this.secret.compute(this.seed);
      const got = bytes.slice(2);
      if (got.length === expected.length && got.every((b, i) => b === expected[i])) {
        this.failures = 0;
        return Uint8Array.of(0x67, 0x02);
      }
      this.failures++;
      if (this.failures >= 3) this.lockedUntil = Date.now() + 40; // 连错 3 次，锁定一小段
      return Uint8Array.of(0x7f, 0x27, 0x35);
    }
    return Uint8Array.of(0x7f, 0x27, 0x12);
  }
}

function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

export { SimSeedKeyEcu, bytesToHex };

/** MINI / 默认演示：模拟 ECU 用算法库里的一个通用算法当私钥，一键解锁能试出它 */
export const demoFlash = new DemoFlashProvider();

/** 每个品牌一个演示 ECU 实例（闪存在会话内保留） */
const demoByModule = new Map<string, DemoFlashProvider>([['', demoFlash]]);

/** 注册某品牌的演示配置（例如奔驰用 Daimler 算法 + 已知 K） */
export function registerDemoFlash(moduleId: string, cfg: Partial<DemoFlashConfig>): void {
  demoByModule.set(moduleId, new DemoFlashProvider(cfg));
}

/** 取某品牌的演示 ECU；没有专门注册的就用默认（MINI 风格） */
export function demoFlashFor(moduleId: string): DemoFlashProvider {
  return demoByModule.get(moduleId) ?? demoFlash;
}
