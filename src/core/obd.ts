import { Elm327, parseHexMessages } from './elm327';

/* ---------------- 实时数据（Mode 01） ---------------- */

export interface PidDef {
  pid: number;
  name: string;
  unit: string;
  /** 数据字节数（不含 41 PID 头） */
  bytes: number;
  decode: (d: number[]) => number;
  digits?: number;
}

const A = (d: number[]) => d[0];
const AB = (d: number[]) => d[0] * 256 + d[1];

export const PIDS: PidDef[] = [
  { pid: 0x0c, name: '发动机转速', unit: 'rpm', bytes: 2, decode: (d) => AB(d) / 4, digits: 0 },
  { pid: 0x0d, name: '车速', unit: 'km/h', bytes: 1, decode: A, digits: 0 },
  { pid: 0x05, name: '冷却液温度', unit: '°C', bytes: 1, decode: (d) => A(d) - 40, digits: 0 },
  { pid: 0x0f, name: '进气温度', unit: '°C', bytes: 1, decode: (d) => A(d) - 40, digits: 0 },
  { pid: 0x04, name: '发动机负荷', unit: '%', bytes: 1, decode: (d) => (A(d) * 100) / 255, digits: 0 },
  { pid: 0x11, name: '节气门开度', unit: '%', bytes: 1, decode: (d) => (A(d) * 100) / 255, digits: 0 },
  { pid: 0x0b, name: '进气歧管压力', unit: 'kPa', bytes: 1, decode: A, digits: 0 },
  { pid: 0x10, name: '空气流量 MAF', unit: 'g/s', bytes: 2, decode: (d) => AB(d) / 100, digits: 1 },
  { pid: 0x0e, name: '点火提前角', unit: '°', bytes: 1, decode: (d) => A(d) / 2 - 64, digits: 1 },
  { pid: 0x06, name: '短期燃油修正 B1', unit: '%', bytes: 1, decode: (d) => (A(d) * 100) / 128 - 100, digits: 1 },
  { pid: 0x07, name: '长期燃油修正 B1', unit: '%', bytes: 1, decode: (d) => (A(d) * 100) / 128 - 100, digits: 1 },
  { pid: 0x33, name: '大气压力', unit: 'kPa', bytes: 1, decode: A, digits: 0 },
  { pid: 0x42, name: '控制模块电压', unit: 'V', bytes: 2, decode: (d) => AB(d) / 1000, digits: 2 },
  { pid: 0x2f, name: '燃油液位', unit: '%', bytes: 1, decode: (d) => (A(d) * 100) / 255, digits: 0 },
  { pid: 0x46, name: '环境温度', unit: '°C', bytes: 1, decode: (d) => A(d) - 40, digits: 0 },
  { pid: 0x5c, name: '机油温度', unit: '°C', bytes: 1, decode: (d) => A(d) - 40, digits: 0 },
];

export function decodePid(def: PidDef, msg: Uint8Array): number | null {
  if (msg.length < 2 + def.bytes || msg[0] !== 0x41 || msg[1] !== def.pid) return null;
  return def.decode(Array.from(msg.slice(2, 2 + def.bytes)));
}

/** 解析 0100/0120/0140... 的“支持的 PID”位图 */
export function parseSupportedBitmap(base: number, data: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    const byte = data[Math.floor(i / 8)];
    if (byte !== undefined && byte & (0x80 >> i % 8)) out.push(base + i + 1);
  }
  return out;
}

/* ---------------- 故障码 ---------------- */

const DTC_LETTERS = ['P', 'C', 'B', 'U'];

export function decodeDtc(hi: number, lo: number): string {
  const letter = DTC_LETTERS[hi >> 6];
  const d1 = (hi >> 4) & 0x03;
  const rest = ((hi & 0x0f) << 8) | lo;
  return letter + d1.toString(16) + rest.toString(16).toUpperCase().padStart(3, '0');
}

/**
 * 从 Mode 03/07/0A 的响应中取出故障码。
 * CAN（二代）：43 NN d1 d2 d3 d4 …（NN 是数量）
 * K-Line（一代）：43 d1 d2 d3 d4 d5 d6，每帧 3 个，不足用 00 00 补齐，可能有多帧
 */
export function parseDtcMessages(messages: Uint8Array[], service: number, isCan: boolean): string[] {
  const out = new Set<string>();
  for (const msg of messages) {
    if (msg[0] !== service + 0x40) continue;
    const start = isCan ? 2 : 1;
    for (let i = start; i + 1 < msg.length; i += 2) {
      if (msg[i] === 0 && msg[i + 1] === 0) continue;
      out.add(decodeDtc(msg[i], msg[i + 1]));
    }
  }
  return [...out];
}

/* ---------------- Mode 09 车辆信息 ---------------- */

/** 把 49 PID … 的多条消息合并成数据区（去掉每帧的头和序号/数量字节） */
function mode09Payload(messages: Uint8Array[], pid: number): number[] {
  const out: number[] = [];
  for (const msg of messages) {
    if (msg[0] !== 0x49 || msg[1] !== pid) continue;
    out.push(...msg.slice(3));
  }
  return out;
}

export function parseVin(messages: Uint8Array[]): string | null {
  const ascii = mode09Payload(messages, 0x02)
    .filter((b) => b >= 0x30 && b <= 0x5a)
    .map((b) => String.fromCharCode(b))
    .join('');
  return ascii.length >= 17 ? ascii.slice(-17) : null;
}

/** 标定号（Calibration ID），每个 16 字节，常用于确认 ECU 当前程序版本 */
export function parseCalIds(messages: Uint8Array[]): string[] {
  const data = mode09Payload(messages, 0x04);
  const ids: string[] = [];
  for (let i = 0; i < data.length; i += 16) {
    const s = String.fromCharCode(...data.slice(i, i + 16).filter((b) => b >= 0x20 && b < 0x7f)).trim();
    if (s) ids.push(s);
  }
  return ids;
}

/** 标定校验码（CVN），每个 4 字节 */
export function parseCvns(messages: Uint8Array[]): string[] {
  const data = mode09Payload(messages, 0x06);
  const out: string[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    out.push(data.slice(i, i + 4).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(''));
  }
  return out;
}

/* ---------------- 高层服务 ---------------- */

export interface MilStatus {
  milOn: boolean;
  dtcCount: number;
}

export interface VehicleInfo {
  vin: string | null;
  calIds: string[];
  cvns: string[];
  ecuName: string | null;
  mil: MilStatus | null;
  supportedPids: number[];
}

export class ObdService {
  supported: number[] = [];

  constructor(private readonly elm: Elm327) {}

  private get isCan(): boolean {
    return this.elm.info?.isCan ?? true;
  }

  async query(cmd: string, timeoutMs?: number): Promise<Uint8Array[]> {
    const res = await this.elm.request(cmd, timeoutMs);
    return res === null ? [] : parseHexMessages(res);
  }

  async loadSupportedPids(): Promise<number[]> {
    const all: number[] = [];
    for (let base = 0; base <= 0xa0; base += 0x20) {
      const cmd = '01' + base.toString(16).toUpperCase().padStart(2, '0');
      const msgs = await this.query(cmd).catch(() => []);
      const msg = msgs.find((m) => m[0] === 0x41 && m[1] === base);
      if (!msg) break;
      const list = parseSupportedBitmap(base, Array.from(msg.slice(2, 6)));
      all.push(...list);
      if (!list.includes(base + 0x20)) break;
    }
    this.supported = all;
    return all;
  }

  async readPid(def: PidDef): Promise<number | null> {
    const cmd = '01' + def.pid.toString(16).toUpperCase().padStart(2, '0');
    const msgs = await this.query(cmd);
    for (const m of msgs) {
      const v = decodePid(def, m);
      if (v !== null) return v;
    }
    return null;
  }

  async readMil(): Promise<MilStatus | null> {
    const msgs = await this.query('0101');
    const m = msgs.find((x) => x[0] === 0x41 && x[1] === 0x01);
    if (!m) return null;
    return { milOn: (m[2] & 0x80) !== 0, dtcCount: m[2] & 0x7f };
  }

  /** stored: 已确认故障（03）；pending: 待定故障（07）；permanent: 永久故障（0A，多数 R 系列不支持） */
  async readDtcs(kind: 'stored' | 'pending' | 'permanent'): Promise<string[]> {
    const service = { stored: 0x03, pending: 0x07, permanent: 0x0a }[kind];
    const msgs = await this.query(service.toString(16).toUpperCase().padStart(2, '0'), 10000);
    return parseDtcMessages(msgs, service, this.isCan);
  }

  /** 清除故障码和冻结帧；成功返回 true */
  async clearDtcs(): Promise<boolean> {
    const msgs = await this.query('04', 10000);
    return msgs.some((m) => m[0] === 0x44);
  }

  async readVehicleInfo(): Promise<VehicleInfo> {
    const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    const vin = parseVin(await safe(this.query('0902', 10000), []));
    const calIds = parseCalIds(await safe(this.query('0904', 10000), []));
    const cvns = parseCvns(await safe(this.query('0906', 10000), []));
    const nameMsgs = await safe(this.query('090A', 10000), []);
    const nameBytes = mode09Payload(nameMsgs, 0x0a).filter((b) => b >= 0x20 && b < 0x7f);
    const ecuName = nameBytes.length ? String.fromCharCode(...nameBytes).replace(/\s+/g, ' ').trim() : null;
    const mil = await safe(this.readMil(), null);
    const supportedPids = this.supported.length ? this.supported : await this.loadSupportedPids();
    return { vin, calIds, cvns, ecuName, mil, supportedPids };
  }
}
