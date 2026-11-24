import type { Transport } from '../transport/transport';

export class ElmError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'ElmError';
  }
}

/** ELM327 返回的这些文本表示命令失败 */
const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/UNABLE TO CONNECT/, '无法与车辆 ECU 建立通讯（请确认点火开关已打开）'],
  [/BUS INIT:?\s*\.*\s*ERROR/, 'K-Line 总线初始化失败（请打开点火开关后重试）'],
  [/CAN ERROR/, 'CAN 总线错误'],
  [/BUS ERROR/, '总线错误'],
  [/BUFFER FULL/, '适配器缓冲区已满'],
  [/FB ERROR/, '适配器反馈错误'],
  [/DATA ERROR/, '数据校验错误'],
  [/^\?$/m, '适配器不支持这条命令'],
  [/STOPPED/, '命令被中断'],
];

export type LogFn = (dir: 'tx' | 'rx' | 'info', text: string) => void;

export interface ElmInfo {
  version: string;
  protocol: string;
  protocolNumber: string;
  /** 6–9 为 ISO 15765-4 CAN（二代 MINI），3/4/5 为 K-Line（一代 MINI） */
  isCan: boolean;
  voltage: string;
}

/**
 * ELM327 驱动：负责发送一条命令并等待 '>' 提示符，返回清理过的文本。
 * 同一时间只允许一条命令在途，内部用队列串行化。
 */
export class Elm327 {
  private buffer = '';
  private waiter: ((text: string) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  info: ElmInfo | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly log: LogFn = () => {},
  ) {
    transport.onData((chunk) => this.handleData(chunk));
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const idx = this.buffer.indexOf('>');
    if (idx >= 0 && this.waiter) {
      const text = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const w = this.waiter;
      this.waiter = null;
      w(text);
    }
  }

  /** 发送一条命令，返回去掉回显和多余空白后的原始响应 */
  send(cmd: string, timeoutMs = 5000): Promise<string> {
    const run = async (): Promise<string> => {
      this.buffer = '';
      const result = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          reject(new ElmError(`命令 ${cmd} 超时（${timeoutMs} ms 内没有响应）`, this.buffer));
        }, timeoutMs);
        this.waiter = (text) => {
          clearTimeout(timer);
          resolve(text);
        };
      });
      this.log('tx', cmd);
      await this.transport.write(cmd + '\r');
      const raw = await result;
      const cleaned = cleanResponse(raw, cmd);
      this.log('rx', cleaned || '(空)');
      return cleaned;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** 发送 OBD 请求，失败时抛出 ElmError；“NO DATA” 返回 null */
  async request(cmd: string, timeoutMs = 5000): Promise<string | null> {
    const res = await this.send(cmd, timeoutMs);
    if (/NO DATA/.test(res)) return null;
    for (const [re, msg] of ERROR_PATTERNS) {
      if (re.test(res)) throw new ElmError(msg, res);
    }
    return res;
  }

  /** 初始化适配器并自动识别车辆协议 */
  async initialize(): Promise<ElmInfo> {
    // ATZ 会重启芯片，部分山寨芯片需要更长时间
    const version = (await this.send('ATZ', 8000)).replace(/\s+/g, ' ').trim();
    await this.send('ATE0'); // 关回显
    await this.send('ATL0'); // 关换行
    await this.send('ATS1'); // 保留空格，方便解析
    await this.send('ATH0'); // 不显示报头
    await this.send('ATAT1'); // 自适应超时
    await this.send('ATSP0'); // 自动搜索协议
    const voltage = await this.send('ATRV').catch(() => '');

    // 0100 会触发协议搜索；K-Line 车型（一代）初始化可能要好几秒
    const probe = await this.send('0100', 20000);
    if (/UNABLE TO CONNECT|BUS INIT.*ERROR|NO DATA/.test(probe)) {
      throw new ElmError('适配器已连接，但没有和车辆 ECU 建立通讯。请打开点火开关（或启动发动机）后重试。', probe);
    }

    const protocol = await this.send('ATDP');
    const dpn = (await this.send('ATDPN')).replace(/^A/, '').trim();
    const num = parseInt(dpn, 16);
    this.info = {
      version,
      protocol: protocol.replace(/^AUTO,\s*/, ''),
      protocolNumber: dpn,
      isCan: num >= 6 && num <= 9,
      voltage,
    };
    this.log('info', `协议：${this.info.protocol}（${dpn}）`);
    return this.info;
  }
}

/** 去掉命令回显、SEARCHING... 等提示，统一换行 */
export function cleanResponse(raw: string, cmd?: string): string {
  let lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^SEARCHING\.*$/i.test(l));
  if (cmd && lines.length > 0 && lines[0].replace(/\s/g, '') === cmd.replace(/\s/g, '')) {
    lines = lines.slice(1);
  }
  return lines.join('\n');
}

/**
 * 把 ELM327 的十六进制响应解析成一条或多条消息。
 * - CAN 多帧（ISO-TP）格式：第一行是长度（如 "014"），后续是 "0: ..", "1: .." 等行，合并成一条消息
 * - 其余情况：每行是一条单独的消息（K-Line 多帧、或多个 ECU 同时应答）
 */
export function parseHexMessages(text: string): Uint8Array[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length > 0);
  const messages: Uint8Array[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lenMatch = /^([0-9A-F]{3})$/.exec(line);
    if (lenMatch || /^[0-9A-F]:/.test(line)) {
      const expected = lenMatch ? parseInt(lenMatch[1], 16) : Infinity;
      if (lenMatch) i++;
      const bytes: number[] = [];
      while (i < lines.length && /^[0-9A-F]:/.test(lines[i])) {
        bytes.push(...hexToBytes(lines[i].slice(2)));
        i++;
      }
      messages.push(Uint8Array.from(bytes.slice(0, expected)));
      continue;
    }
    // 只接受纯十六进制行，避免把 "NO DATA" 之类的文字误当成数据
    if (/^[0-9A-F ]+$/.test(line)) {
      const bytes = hexToBytes(line);
      if (bytes.length > 0) messages.push(Uint8Array.from(bytes));
    }
    i++;
  }
  return messages;
}

export function hexToBytes(s: string): number[] {
  const clean = s.replace(/[^0-9A-Fa-f]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}
