import { bytesToHex, type SeedKeyAlgorithm } from './seedkey';
import { securityAccess, type SecurityAccessIO, type UnlockResult } from './security-access';
import type { FlashContext, FlashMemoryRegion, FlashProvider } from './vehicle-module';

/**
 * 真实的 UDS（ISO 14229）刷写协议层。
 *
 * 一次完整刷写用到的服务:
 *   10 02         进入编程会话（DiagnosticSessionControl）
 *   27 xx / xx+1  安全访问 seed/key（SecurityAccess，见 security-access.ts）
 *   31 01 <rid>   例程控制:擦除（RoutineControl，start）
 *   34 ...        请求下载（RequestDownload）→ ECU 返回每块最大长度
 *   36 bsc data   传输数据（TransferData），分块,块计数 1..FF 循环
 *   37            传输结束（RequestTransferExit）
 *   31 01 <rid>   例程控制:校验和/编程依赖检查
 *   11 01         ECU 复位
 * 读取（备份）用 35 请求上传 + 36 读回,或 23 按地址读内存。
 *
 * ISO-TP 分帧由 ELM327（CAN）自动处理,这里只管 UDS 服务层和分块。
 */

export class UdsError extends Error {
  constructor(
    message: string,
    readonly sid: number,
    readonly nrc?: number,
  ) {
    super(message);
    this.name = 'UdsError';
  }
}

const NRC: Record<number, string> = {
  0x11: '服务不支持',
  0x13: '报文长度或格式错误',
  0x22: '条件不满足',
  0x24: '请求顺序错误',
  0x31: '请求超出范围（地址/长度无效）',
  0x33: '安全访问被拒绝（未解锁）',
  0x35: '密钥错误',
  0x36: '超过尝试次数',
  0x37: '需要等待',
  0x70: '上传/下载被拒绝',
  0x71: '传输数据暂停',
  0x72: '通用编程失败',
  0x73: '块计数错误',
  0x7f: '当前会话不支持该服务',
};

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

function beBytes(value: number, len: number): number[] {
  const out: number[] = [];
  for (let i = len - 1; i >= 0; i--) out.push((value >>> (i * 8)) & 0xff);
  return out;
}

export interface UdsFlashConfig {
  regions: FlashMemoryRegion[];
  /** 编程会话子功能,通常 0x02 */
  programmingSession: number;
  /** 解锁用:候选算法 + 安全等级（请求/应答子功能） */
  algorithms: SeedKeyAlgorithm[];
  securityRequestLevel: number;
  securitySendLevel: number;
  /** 地址与长度各占几字节（ALFID） */
  addressBytes: number;
  lengthBytes: number;
  /** dataFormatIdentifier,未压缩未加密为 0x00 */
  dataFormatId: number;
  /** 擦除例程 / 校验例程的 routineId（可选） */
  eraseRoutineId?: number;
  checksumRoutineId?: number;
  lockoutWaitMs?: number;
}

export class UdsClient {
  constructor(private readonly io: SecurityAccessIO) {}

  /** 发一条 UDS 请求,校验是肯定响应（SID+0x40）；否则抛 UdsError */
  private async request(bytes: number[], expectSid: number): Promise<Uint8Array> {
    const resp = await this.io.request(bytes.map(hex).join(''));
    if (resp.length >= 3 && resp[0] === 0x7f && resp[1] === expectSid) {
      const nrc = resp[2];
      throw new UdsError(`服务 0x${hex(expectSid)} 被拒绝:${NRC[nrc] ?? '0x' + hex(nrc)}`, expectSid, nrc);
    }
    if (resp[0] !== expectSid + 0x40) {
      throw new UdsError(`服务 0x${hex(expectSid)} 响应异常:${bytesToHex(resp)}`, expectSid);
    }
    return resp;
  }

  async startSession(sub: number): Promise<void> {
    await this.request([0x10, sub], 0x10);
  }

  async ecuReset(sub = 0x01): Promise<void> {
    await this.request([0x11, sub], 0x11);
  }

  async securityAccess(cfg: UdsFlashConfig, report?: (m: string) => void): Promise<UnlockResult> {
    return securityAccess(this.io, {
      requestLevel: cfg.securityRequestLevel,
      sendLevel: cfg.securitySendLevel,
      algorithms: cfg.algorithms,
      maxAttempts: cfg.algorithms.length,
      report,
      lockoutWaitMs: cfg.lockoutWaitMs,
    });
  }

  /** 例程控制 start（0x31 0x01） */
  async routineStart(routineId: number, data: number[] = []): Promise<Uint8Array> {
    return this.request([0x31, 0x01, (routineId >> 8) & 0xff, routineId & 0xff, ...data], 0x31);
  }

  /** 请求下载,返回每块最大数据长度 */
  async requestDownload(cfg: UdsFlashConfig, addr: number, size: number): Promise<number> {
    const alfid = (cfg.lengthBytes << 4) | cfg.addressBytes;
    const resp = await this.request(
      [0x34, cfg.dataFormatId, alfid, ...beBytes(addr, cfg.addressBytes), ...beBytes(size, cfg.lengthBytes)],
      0x34,
    );
    // 34 响应: 74 <lenFmt> <maxBlockLen...>；maxBlockLen 含 36+bsc 的开销
    const lenFmt = (resp[1] >> 4) & 0x0f;
    let max = 0;
    for (let i = 0; i < lenFmt; i++) max = (max << 8) | resp[2 + i];
    return Math.max(1, max - 2); // 去掉 36 和 bsc 两字节
  }

  /** 请求上传,返回每块最大数据长度 */
  async requestUpload(cfg: UdsFlashConfig, addr: number, size: number): Promise<number> {
    const alfid = (cfg.lengthBytes << 4) | cfg.addressBytes;
    const resp = await this.request(
      [0x35, cfg.dataFormatId, alfid, ...beBytes(addr, cfg.addressBytes), ...beBytes(size, cfg.lengthBytes)],
      0x35,
    );
    const lenFmt = (resp[1] >> 4) & 0x0f;
    let max = 0;
    for (let i = 0; i < lenFmt; i++) max = (max << 8) | resp[2 + i];
    return Math.max(1, max - 2);
  }

  /** 传输一块（写）；bsc 为块计数 */
  async transferWrite(bsc: number, data: Uint8Array): Promise<void> {
    await this.request([0x36, bsc & 0xff, ...data], 0x36);
  }

  /** 传输一块（读）；返回这块数据 */
  async transferRead(bsc: number): Promise<Uint8Array> {
    const resp = await this.request([0x36, bsc & 0xff], 0x36);
    return resp.slice(2); // 76 <bsc> <data...>
  }

  async transferExit(): Promise<void> {
    await this.request([0x37], 0x37);
  }
}

/** 真车用的 UDS 刷写实现。各车型只需提供 UdsFlashConfig（含解锁算法、地址、例程 id） */
export class UdsFlashProvider implements FlashProvider {
  readonly regions: FlashMemoryRegion[];
  constructor(
    private readonly client: UdsClient,
    private readonly cfg: UdsFlashConfig,
  ) {
    this.regions = cfg.regions;
  }

  async enterProgrammingSession(ctx: FlashContext): Promise<void> {
    ctx.report(0, '进入编程会话（10 02）…');
    await this.client.startSession(this.cfg.programmingSession);
  }

  async probeUnlock(ctx: FlashContext): Promise<UnlockResult> {
    return this.client.securityAccess(this.cfg, (m) => ctx.report(0, m));
  }

  async unlock(ctx: FlashContext): Promise<void> {
    const res = await this.probeUnlock(ctx);
    if (!res.unlocked) throw new Error(res.reason ?? '解锁失败');
  }

  async readRegion(ctx: FlashContext, region: FlashMemoryRegion): Promise<Uint8Array> {
    const maxBlock = await this.client.requestUpload(this.cfg, region.address, region.size);
    const out = new Uint8Array(region.size);
    let off = 0;
    let bsc = 1;
    while (off < region.size) {
      if (ctx.cancelled()) break;
      const chunk = await this.client.transferRead(bsc);
      if (chunk.length === 0) break;
      out.set(chunk.subarray(0, Math.min(chunk.length, region.size - off)), off);
      off += chunk.length;
      bsc = (bsc + 1) & 0xff;
      ctx.report(off / region.size, `读取 ${region.name} ${Math.round((off / region.size) * 100)}%`);
    }
    await this.client.transferExit();
    void maxBlock;
    return out;
  }

  async validateImage(region: FlashMemoryRegion, data: Uint8Array): Promise<void> {
    if (data.length !== region.size) throw new Error(`文件大小 ${data.length} 与区域 ${region.size}（${region.name}）不符`);
  }

  async writeRegion(ctx: FlashContext, region: FlashMemoryRegion, data: Uint8Array): Promise<void> {
    if (this.cfg.eraseRoutineId !== undefined) {
      ctx.report(0.4, '擦除…');
      await this.client.routineStart(this.cfg.eraseRoutineId, [
        ...beBytes(region.address, this.cfg.addressBytes),
        ...beBytes(region.size, this.cfg.lengthBytes),
      ]);
    }
    const maxBlock = await this.client.requestDownload(this.cfg, region.address, region.size);
    let off = 0;
    let bsc = 1;
    while (off < data.length) {
      if (ctx.cancelled()) throw new Error('写入被中断——ECU 程序不完整,请立即重新恢复备份');
      const chunk = data.subarray(off, off + maxBlock);
      await this.client.transferWrite(bsc, chunk);
      off += chunk.length;
      bsc = (bsc + 1) & 0xff;
      ctx.report(0.4 + (off / data.length) * 0.5, `写入 ${region.name} ${Math.round((off / data.length) * 100)}%`);
    }
    await this.client.transferExit();
  }

  async finalizeChecksum(ctx: FlashContext, region: FlashMemoryRegion): Promise<void> {
    if (this.cfg.checksumRoutineId === undefined) return;
    ctx.report(0.9, '校验（31 01）…');
    await this.client.routineStart(this.cfg.checksumRoutineId, [
      ...beBytes(region.address, this.cfg.addressBytes),
      ...beBytes(region.size, this.cfg.lengthBytes),
    ]);
  }

  async reset(ctx: FlashContext): Promise<void> {
    ctx.report(0.97, '复位 ECU（11 01）…');
    await this.client.ecuReset(0x01).catch(() => undefined);
  }
}
