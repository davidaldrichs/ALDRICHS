import { describe, expect, it } from 'vitest';
import { evalExpr, linearize, parseXdf, readMap, writeMap, rawRange, MapReadonlyError, mapStats } from '../src/platform/map-def';

describe('公式求值与线性化', () => {
  it('求值', () => {
    expect(evalExpr('X*0.75-24', 128)).toBeCloseTo(72);
    expect(evalExpr('(X-128)*0.1', 138)).toBeCloseTo(1);
    expect(evalExpr('X', 42)).toBe(42);
  });
  it('线性公式识别系数', () => {
    const l1 = linearize('X*0.75-24')!;
    expect(l1.a).toBeCloseTo(0.75); expect(l1.b).toBeCloseTo(-24);
    const l2 = linearize('(X-128)*0.1')!;
    expect(l2.a).toBeCloseTo(0.1); expect(l2.b).toBeCloseTo(-12.8);
  });
  it('非线性返回 null', () => {
    expect(linearize('X*X')).toBeNull();
  });
  it('原始范围', () => {
    expect(rawRange(8, false)).toEqual([0, 255]);
    expect(rawRange(8, true)).toEqual([-128, 127]);
    expect(rawRange(16, false)).toEqual([0, 65535]);
  });
});

// 构造一个最小 XDF:一个标量(增压限制,16位大端,X*0.1 kPa)和一个 2x2 点火表(8位,X*0.75-24)
const XDF = `<XDFFORMAT version="1.60"><XDFHEADER><flags>0x1</flags><BASEOFFSET offset="0" subtract="0"/></XDFHEADER>
<XDFCONSTANT uniqueid="0x1"><title>增压限制</title><EMBEDDEDDATA mmedaddress="0x10" mmedelementsizebits="16" mmedtypeflags="0x0"/><units>kPa</units><MATH equation="X*0.1"><VAR id="X"/></MATH><rangelow>0</rangelow><rangehigh>250</rangehigh></XDFCONSTANT>
<XDFTABLE uniqueid="0x2"><title>点火提前</title><XDFAXIS id="x"></XDFAXIS><XDFAXIS id="z"><EMBEDDEDDATA mmedaddress="0x20" mmedelementsizebits="8" mmedrowcount="2" mmedcolcount="2" mmedtypeflags="0x0"/><units>deg</units><MATH equation="X*0.75-24"><VAR id="X"/></MATH></XDFAXIS></XDFTABLE></XDFFORMAT>`;

describe('XDF 解析 + map 读写', () => {
  const items = parseXdf(XDF, { endian: 'big' });
  const scalar = items.find((i) => i.kind === 'scalar')!;
  const table = items.find((i) => i.kind === 'table')!;

  it('解析出标量和表格', () => {
    expect(items).toHaveLength(2);
    expect(scalar.title).toBe('增压限制');
    expect(scalar.address).toBe(0x10);
    expect(scalar.sizeBits).toBe(16);
    expect(scalar.unit).toBe('kPa');
    expect(scalar.min).toBe(0);
    expect(scalar.max).toBe(250);
    expect(table.kind).toBe('table');
    expect(table.rows).toBe(2);
    expect(table.cols).toBe(2);
    expect(table.sizeBits).toBe(8);
  });

  it('从 ROM 读物理值', () => {
    const rom = new Uint8Array(0x40);
    const dv = new DataView(rom.buffer);
    dv.setUint16(0x10, 2000, false); // 大端 → 2000*0.1 = 200 kPa
    rom[0x20] = 128; rom[0x21] = 136; rom[0x22] = 0; rom[0x23] = 200; // 点火: 128*0.75-24=72, 136→78, 0→-24, 200→126
    expect(readMap(rom, scalar)[0]).toBeCloseTo(200);
    expect(readMap(rom, table)).toEqual([72, 78, -24, 126]);
  });

  it('写回 ROM round-trip（线性反算 + 范围钳制）', () => {
    const rom = new Uint8Array(0x40);
    const rom2 = writeMap(rom, scalar, [150]); // 150 kPa → raw 1500
    expect(readMap(rom2, scalar)[0]).toBeCloseTo(150);
    // 超过 max=250 → 钳到 250
    const rom3 = writeMap(rom, scalar, [999]);
    expect(readMap(rom3, scalar)[0]).toBeCloseTo(250);
    // 表格写回
    const rom4 = writeMap(rom, table, [10, 20, 30, 0]);
    expect(readMap(rom4, table).map((v) => Math.round(v))).toEqual([10, 20, 30, 0]);
  });

  it('写回不越过原始位宽（8位 unsigned 封顶 255 → 物理封顶）', () => {
    const rom = new Uint8Array(0x40);
    const rom2 = writeMap(rom, table, [9999, 9999, 9999, 9999]); // raw 远超 255 → 封到 255 → 255*0.75-24
    const max = 255 * 0.75 - 24;
    expect(readMap(rom2, table)[0]).toBeCloseTo(max);
  });

  it('非线性 map 只读', () => {
    const ro = { ...table, equation: 'X*X', linear: null };
    expect(() => writeMap(new Uint8Array(0x40), ro, [1, 2, 3, 4])).toThrow(MapReadonlyError);
  });

  it('统计', () => {
    expect(mapStats([10, 20, 30])).toEqual({ min: 10, max: 30, mean: 20 });
  });
});
