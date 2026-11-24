/**
 * MINI R 系列车型资料。
 * 发动机和 ECU 型号是各车型的常见配置，具体以实际读到的标定号/VIN 为准。
 */

export type Generation = 1 | 2;

export interface EngineInfo {
  code: string;
  desc: string;
  ecu: string;
}

export interface ChassisInfo {
  code: string;
  name: string;
  generation: Generation;
  years: string;
  engines: EngineInfo[];
}

const GEN1_ENGINES: EngineInfo[] = [
  { code: 'W10B16', desc: '1.6L 自然吸气（One / Cooper）', ecu: 'Siemens EMS2000' },
  { code: 'W11B16', desc: '1.6L 机械增压（Cooper S / JCW）', ecu: 'Siemens EMS2000' },
  { code: '1ND-TV', desc: '1.4L 柴油（One D，丰田发动机）', ecu: 'Denso' },
];

const GEN2_ENGINES: EngineInfo[] = [
  { code: 'N12B16', desc: '1.6L 自然吸气（One / Cooper，2006–2010）', ecu: 'Siemens MEV17' },
  { code: 'N16B16', desc: '1.6L 自然吸气（One / Cooper，2010 后）', ecu: 'Siemens MEV17.2' },
  { code: 'N14B16', desc: '1.6L 涡轮增压（Cooper S / JCW，2006–2010）', ecu: 'Bosch MED17.2' },
  { code: 'N18B16', desc: '1.6L 涡轮增压（Cooper S / JCW，2010 后）', ecu: 'Bosch MEVD17.2.2' },
  { code: 'W16D16', desc: '1.6L 柴油（Cooper D，2007–2010）', ecu: 'Bosch EDC16C34' },
  { code: 'N47C16/N47C20', desc: '1.6/2.0L 柴油（Cooper D / SD，2010 后）', ecu: 'Bosch EDC17C50' },
];

export const CHASSIS: ChassisInfo[] = [
  { code: 'R50', name: 'Hatch 掀背（One / Cooper / One D）', generation: 1, years: '2001–2006', engines: GEN1_ENGINES },
  { code: 'R53', name: 'Hatch 掀背（Cooper S / JCW）', generation: 1, years: '2002–2006', engines: GEN1_ENGINES.slice(1, 2) },
  { code: 'R52', name: 'Convertible 敞篷', generation: 1, years: '2004–2008', engines: GEN1_ENGINES.slice(0, 2) },
  { code: 'R56', name: 'Hatch 掀背', generation: 2, years: '2006–2013', engines: GEN2_ENGINES },
  { code: 'R55', name: 'Clubman 旅行', generation: 2, years: '2007–2014', engines: GEN2_ENGINES },
  { code: 'R57', name: 'Convertible 敞篷', generation: 2, years: '2009–2015', engines: GEN2_ENGINES },
  { code: 'R58', name: 'Coupé 双门轿跑', generation: 2, years: '2011–2015', engines: GEN2_ENGINES },
  { code: 'R59', name: 'Roadster 双座敞篷', generation: 2, years: '2012–2015', engines: GEN2_ENGINES },
  { code: 'R60', name: 'Countryman 跨界', generation: 2, years: '2010–2016', engines: GEN2_ENGINES },
  { code: 'R61', name: 'Paceman', generation: 2, years: '2012–2016', engines: GEN2_ENGINES },
];

export function generationLabel(g: Generation): string {
  return g === 1 ? '一代（R50/R52/R53）' : '二代（R55–R61）';
}

/** 各代车型在 OBD 口上的通讯方式 */
export function expectedProtocol(g: Generation): string {
  return g === 1 ? 'K-Line（ISO 9141-2 / ISO 14230 KWP2000）' : 'CAN（ISO 15765-4，500 kbit/s）';
}

const YEAR_CODES = '123456789ABCDEFG';

export interface VinGuess {
  valid: boolean;
  isMini: boolean;
  modelYear: number | null;
  /** 根据年款推测；2006–2008 年款一、二代有重叠，此时为 null */
  generation: Generation | null;
  note: string;
}

export function guessFromVin(vin: string): VinGuess {
  const v = vin.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) {
    return { valid: false, isMini: false, modelYear: null, generation: null, note: 'VIN 格式不正确（应为 17 位，不含 I/O/Q）' };
  }
  const isMini = v.startsWith('WMW') || v.startsWith('WMZ');
  const idx = YEAR_CODES.indexOf(v[9]);
  const modelYear = idx >= 0 ? 2001 + idx : null;
  let generation: Generation | null = null;
  let note: string;
  if (modelYear === null) {
    note = '无法从第 10 位识别年款';
  } else if (modelYear <= 2006) {
    generation = 1;
    note = `${modelYear} 年款，应为一代`;
  } else if (modelYear >= 2009) {
    generation = 2;
    note = `${modelYear} 年款，应为二代`;
  } else {
    note = `${modelYear} 年款：二代 R56 已上市，但一代 R52 敞篷仍在销售，请手动确认底盘`;
  }
  if (!isMini) note = '不是 MINI 的 VIN（应以 WMW 或 WMZ 开头）；' + note;
  return { valid: true, isMini, modelYear, generation, note };
}

export interface Capability {
  name: string;
  gen1: string;
  gen2: string;
  status: 'ready' | 'planned' | 'unsupported';
}

/** 功能清单：诊断已实现；编码和刷写需要宝马私有协议，见 README */
export const CAPABILITIES: Capability[] = [
  { name: '读取 / 清除故障码（标准 OBD）', gen1: 'ELM327', gen2: 'ELM327', status: 'ready' },
  { name: '实时数据流', gen1: 'ELM327', gen2: 'ELM327', status: 'ready' },
  { name: 'VIN / 标定号 / CVN', gen1: 'ELM327', gen2: 'ELM327', status: 'ready' },
  { name: '读取全车模块故障（ABS、气囊、车身等）', gen1: 'K+DCAN', gen2: 'K+DCAN / ELM327', status: 'planned' },
  { name: '隐藏功能编码', gen1: 'K+DCAN（可改项目很少）', gen2: 'K+DCAN', status: 'planned' },
  { name: 'ECU 刷写（动力程序）', gen1: 'K+DCAN（K-Line）', gen2: 'K+DCAN（D-CAN）', status: 'planned' },
];
