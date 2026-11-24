/**
 * ECU 标定 map 定义（TunerPro XDF 子集）。
 *
 * 把 ROM（原厂程序二进制）里一块地址 + 位宽 + 换算公式,解释成有名字、有单位、有范围的
 * 标量或表格。这是"调马力"的地基:读出增压/点火/喷油等 map,在范围内改,再写回 ROM。
 *
 * 换算:物理值 = equation(raw)。读取支持任意公式;写回只支持**线性**公式(raw = (phys-b)/a),
 * 这覆盖绝大多数 ECU map。非线性公式只读(写回会标为不可改),诚实不瞎写。
 *
 * 说明:XDF 的字节序/符号位标志在不同文件里约定不完全一致,这里按常见约定解析并可覆盖,
 * 用前请拿一个已知值核对。解析的是常见子集(XDFCONSTANT / XDFTABLE 的 z 轴 EMBEDDEDDATA + MATH)。
 */

export type Endian = 'big' | 'little';

export interface MapItem {
  id: string;
  title: string;
  kind: 'scalar' | 'table';
  address: number;
  sizeBits: 8 | 16 | 32;
  signed: boolean;
  endian: Endian;
  rows: number;
  cols: number;
  unit: string;
  equation: string;
  /** 线性系数 {a,b}: phys=a*raw+b；非线性为 null（只读） */
  linear: { a: number; b: number } | null;
  /** 物理值安全范围（可选，用于编辑钳制） */
  min?: number;
  max?: number;
}

/* ---------------- 公式求值（+ - * / ( ) 和变量 X） ---------------- */

export function evalExpr(eq: string, x: number): number {
  let i = 0;
  const s = eq.replace(/\s+/g, '');
  const peek = () => s[i];
  function num(): number {
    let j = i;
    while (j < s.length && /[0-9.eE]/.test(s[j]) && !(s[j] === 'e' && false)) j++;
    const v = parseFloat(s.slice(i, j));
    i = j;
    return v;
  }
  function factor(): number {
    if (peek() === '(') {
      i++;
      const v = expr();
      if (peek() === ')') i++;
      return v;
    }
    if (peek() === '-') {
      i++;
      return -factor();
    }
    if (peek() === '+') {
      i++;
      return factor();
    }
    const c = peek();
    if (c === 'X' || c === 'x') {
      i++;
      return x;
    }
    return num();
  }
  function term(): number {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const out = expr();
  if (!Number.isFinite(out)) throw new Error(`公式无法求值: ${eq}`);
  return out;
}

/** 判断公式是否线性,返回 {a,b} 或 null */
export function linearize(eq: string): { a: number; b: number } | null {
  const b = evalExpr(eq, 0);
  const a = evalExpr(eq, 1) - b;
  for (const x of [2, 5, -3, 100]) {
    if (Math.abs(evalExpr(eq, x) - (a * x + b)) > 1e-6 * (1 + Math.abs(a * x + b))) return null;
  }
  return { a, b };
}

/* ---------------- 原始值读写 ---------------- */

export function rawRange(sizeBits: number, signed: boolean): [number, number] {
  if (signed) return [-(2 ** (sizeBits - 1)), 2 ** (sizeBits - 1) - 1];
  return [0, 2 ** sizeBits - 1];
}

function readRaw(rom: Uint8Array, addr: number, item: Pick<MapItem, 'sizeBits' | 'signed' | 'endian'>): number {
  const dv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const le = item.endian === 'little';
  switch (item.sizeBits) {
    case 8: return item.signed ? dv.getInt8(addr) : dv.getUint8(addr);
    case 16: return item.signed ? dv.getInt16(addr, le) : dv.getUint16(addr, le);
    case 32: return item.signed ? dv.getInt32(addr, le) : dv.getUint32(addr, le);
  }
}

function writeRaw(rom: Uint8Array, addr: number, item: Pick<MapItem, 'sizeBits' | 'signed' | 'endian'>, raw: number): void {
  const dv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const le = item.endian === 'little';
  const [lo, hi] = rawRange(item.sizeBits, item.signed);
  const v = Math.max(lo, Math.min(hi, Math.round(raw)));
  switch (item.sizeBits) {
    case 8: item.signed ? dv.setInt8(addr, v) : dv.setUint8(addr, v); break;
    case 16: item.signed ? dv.setInt16(addr, v, le) : dv.setUint16(addr, v, le); break;
    case 32: item.signed ? dv.setInt32(addr, v, le) : dv.setUint32(addr, v, le); break;
  }
}

const bytesPer = (bits: number) => bits / 8;

/** 读出 map 的物理值（行优先）；标量返回长度 1 */
export function readMap(rom: Uint8Array, item: MapItem): number[] {
  const out: number[] = [];
  const step = bytesPer(item.sizeBits);
  const n = item.rows * item.cols;
  for (let k = 0; k < n; k++) {
    const raw = readRaw(rom, item.address + k * step, item);
    out.push(evalExpr(item.equation, raw));
  }
  return out;
}

export class MapReadonlyError extends Error {
  constructor() {
    super('该 map 为非线性公式,只读,不能写回');
    this.name = 'MapReadonlyError';
  }
}

/** 把物理值写回 ROM（返回新副本）。仅线性公式可写;超出 min/max 或原始范围会被钳制 */
export function writeMap(rom: Uint8Array, item: MapItem, values: number[]): Uint8Array {
  if (!item.linear) throw new MapReadonlyError();
  const { a, b } = item.linear;
  if (a === 0) throw new MapReadonlyError();
  const out = rom.slice();
  const step = bytesPer(item.sizeBits);
  for (let k = 0; k < values.length; k++) {
    let phys = values[k];
    if (item.min !== undefined) phys = Math.max(item.min, phys);
    if (item.max !== undefined) phys = Math.min(item.max, phys);
    writeRaw(out, item.address + k * step, item, (phys - b) / a);
  }
  return out;
}

/* ---------------- XDF 解析（常见子集） ---------------- */

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m?.[1];
}
function num(v: string | undefined, d = 0): number {
  if (v === undefined) return d;
  return v.trim().toLowerCase().startsWith('0x') ? parseInt(v, 16) : parseFloat(v);
}
function inner(block: string, tagName: string): string | undefined {
  const m = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i').exec(block);
  return m?.[1];
}
function sizeOf(bits: number): 8 | 16 | 32 {
  return bits <= 8 ? 8 : bits <= 16 ? 16 : 32;
}

export interface XdfParseOptions {
  endian?: Endian;
  /** mmedtypeflags 中表示“有符号”的位,默认 0x01 */
  signedFlag?: number;
}

export function parseXdf(xml: string, opts: XdfParseOptions = {}): MapItem[] {
  const endian: Endian = opts.endian ?? 'big';
  const signedFlag = opts.signedFlag ?? 0x01;
  // BASEOFFSET
  const baseTag = /<BASEOFFSET[^>]*>/i.exec(xml)?.[0] ?? '';
  const baseOffset = num(attr(baseTag, 'offset'), 0);
  const baseSubtract = num(attr(baseTag, 'subtract'), 0) !== 0;
  const applyBase = (a: number) => (baseSubtract ? a - baseOffset : a + baseOffset);

  const items: MapItem[] = [];
  const parseEmbedded = (block: string, kind: 'scalar' | 'table', idx: number): MapItem | null => {
    const emb = /<EMBEDDEDDATA[^>]*\/?>/i.exec(block)?.[0];
    if (!emb) return null;
    const addr = applyBase(num(attr(emb, 'mmedaddress')));
    const bits = num(attr(emb, 'mmedelementsizebits'), 16);
    const flags = num(attr(emb, 'mmedtypeflags'), 0);
    const rows = Math.max(1, num(attr(emb, 'mmedrowcount'), 1));
    const cols = Math.max(1, num(attr(emb, 'mmedcolcount'), 1));
    const title = (inner(block, 'title') ?? `map_${idx}`).trim();
    const unit = (inner(block, 'units') ?? '').trim();
    const mathTag = /<MATH[^>]*>/i.exec(block)?.[0];
    const equation = (attr(mathTag ?? '', 'equation') ?? 'X').trim();
    const rangelow = inner(block, 'rangelow');
    const rangehigh = inner(block, 'rangehigh');
    let linear: { a: number; b: number } | null = null;
    try {
      linear = linearize(equation);
    } catch {
      linear = null;
    }
    return {
      id: attr(block.slice(0, 200), 'uniqueid') ?? `${kind}_${idx}`,
      title,
      kind,
      address: addr,
      sizeBits: sizeOf(bits),
      signed: (flags & signedFlag) !== 0,
      endian,
      rows: kind === 'scalar' ? 1 : rows,
      cols: kind === 'scalar' ? 1 : cols,
      unit,
      equation,
      linear,
      min: rangelow !== undefined ? parseFloat(rangelow) : undefined,
      max: rangehigh !== undefined ? parseFloat(rangehigh) : undefined,
    };
  };

  let idx = 0;
  for (const m of xml.matchAll(/<XDFCONSTANT[\s\S]*?<\/XDFCONSTANT>/gi)) {
    const it = parseEmbedded(m[0], 'scalar', idx++);
    if (it) items.push(it);
  }
  for (const m of xml.matchAll(/<XDFTABLE[\s\S]*?<\/XDFTABLE>/gi)) {
    // 取 z 轴（数据轴）的 EMBEDDEDDATA；没有 id="z" 就取含行列数的那个轴
    const zAxis = /<XDFAXIS[^>]*id="z"[^>]*>[\s\S]*?<\/XDFAXIS>/i.exec(m[0])?.[0];
    const block = zAxis ? `${inner(m[0], 'title') ? `<title>${inner(m[0], 'title')}</title>` : ''}${zAxis}` : m[0];
    const it = parseEmbedded(block, 'table', idx++);
    if (it) items.push(it);
  }
  return items;
}

/** 表格统计,便于界面展示 */
export function mapStats(values: number[]): { min: number; max: number; mean: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return { min, max, mean };
}
