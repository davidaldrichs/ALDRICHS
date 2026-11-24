import type { FlashContext, FlashMemoryRegion, FlashProvider } from './vehicle-module';

/**
 * 通用刷写流程调度器。
 *
 * 各车型的差异都在 FlashProvider 里；这里只负责固定的步骤顺序、
 * 进度汇报、取消检查，以及刷写前后强制的安全检查（电压、备份）。
 * 这样加新车型时不用重写流程，只填 FlashProvider。
 */

export interface FlashOptions {
  region: FlashMemoryRegion;
  image: Uint8Array;
  /** 刷写前是否强制先备份原厂程序（强烈建议 true） */
  backupFirst: boolean;
  /** 最低允许电压，低于此值拒绝刷写，避免中途断电变砖 */
  minVoltage: number;
  /** 写完后读回比对（恢复原厂备份时必须开启） */
  verifyAfterWrite?: boolean;
}

export interface FlashResult {
  backup: Uint8Array | null;
}

export class FlashCancelled extends Error {
  constructor() {
    super('刷写已取消');
    this.name = 'FlashCancelled';
  }
}

export class FlashRunner {
  constructor(private readonly provider: FlashProvider) {}

  private checkCancel(ctx: FlashContext): void {
    if (ctx.cancelled()) throw new FlashCancelled();
  }

  /** 读取（备份）一段内存 */
  async backup(ctx: FlashContext, region: FlashMemoryRegion): Promise<Uint8Array> {
    ctx.report(0, `正在读取 ${region.name}…`);
    await this.provider.enterProgrammingSession(ctx);
    this.checkCancel(ctx);
    await this.provider.unlock(ctx);
    this.checkCancel(ctx);
    const data = await this.provider.readRegion(ctx, region);
    await this.provider.reset(ctx);
    ctx.report(1, '读取完成');
    return data;
  }

  /** 完整刷写流程 */
  async flash(ctx: FlashContext, opts: FlashOptions): Promise<FlashResult> {
    // 1) 刷前安全检查
    ctx.report(0, '检查电压…');
    await assertVoltage(ctx, opts.minVoltage);
    await this.provider.validateImage(opts.region, opts.image);
    this.checkCancel(ctx);

    // 2) 进会话 + 解锁
    ctx.report(0.05, '进入编程会话…');
    await this.provider.enterProgrammingSession(ctx);
    this.checkCancel(ctx);
    ctx.report(0.1, '安全认证（seed/key）…');
    await this.provider.unlock(ctx);
    this.checkCancel(ctx);

    // 3) 备份
    let backup: Uint8Array | null = null;
    if (opts.backupFirst) {
      ctx.report(0.15, '备份原厂程序…');
      backup = await this.provider.readRegion(ctx, opts.region);
      this.checkCancel(ctx);
    }

    // 4) 写入
    ctx.report(0.4, '擦除并写入…');
    await this.provider.writeRegion(ctx, opts.region, opts.image);
    this.checkCancel(ctx);

    // 5) 校验和
    ctx.report(0.9, '修正校验和…');
    await this.provider.finalizeChecksum(ctx, opts.region);

    // 6) 读回校验
    if (opts.verifyAfterWrite) {
      ctx.report(0.93, '读回校验…');
      const readBack = await this.provider.readRegion(ctx, opts.region);
      const bad = firstDiff(readBack, opts.image);
      if (bad >= 0) {
        throw new Error(`读回校验失败：第 0x${bad.toString(16)} 字节不一致。请不要断电，立即重新恢复备份。`);
      }
    }

    // 7) 复位
    ctx.report(0.97, '复位 ECU…');
    await this.provider.reset(ctx);
    ctx.report(1, '刷写完成');
    return { backup };
  }
}

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

async function assertVoltage(ctx: FlashContext, min: number): Promise<void> {
  const raw = await ctx.elm.send('ATRV').catch(() => '');
  const v = parseFloat(raw.replace(/[^\d.]/g, ''));
  if (Number.isFinite(v) && v < min) {
    throw new Error(`电压过低（${v}V < ${min}V）。刷写中断电会导致 ECU 变砖，请接稳压电源后重试。`);
  }
}
