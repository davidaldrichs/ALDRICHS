import type { Elm327 } from '../core/elm327';
import type { ObdService } from '../core/obd';
import { describeDtc as describeGeneric } from '../core/dtc-db';
import { CHASSIS, guessFromVin } from '../core/mini';
import type { Identification, SubModel, Variant, VehicleModule, VinAnalysis } from '../platform/vehicle-module';

/** MINI 专属故障码补充说明（通用码在 core/dtc-db.ts 里已带 MINI 常见原因） */
const MINI_DTC: Record<string, string> = {
  P1523: 'VANOS 凸轮轴调节 —— MINI 常见机油压力/电磁阀问题',
  P1529: 'VANOS 控制',
  P1776: '机械增压旁通阀（一代 R53 Cooper S）',
  P2082: '排气温度传感器（二代柴油）',
};

function variant(id: string, label: string, protocol: string, isCan: boolean, codes: string[]): Variant {
  const subModels: SubModel[] = CHASSIS.filter((c) => codes.includes(c.code)).map((c) => ({
    code: c.code,
    name: c.name,
    years: c.years,
    powertrains: c.engines.map((e) => ({ code: e.code, desc: e.desc, ecu: e.ecu })),
  }));
  return { id, label, protocol, isCan, subModels };
}

export const miniR: VehicleModule = {
  id: 'mini-r',
  brand: 'MINI',
  name: 'MINI R 系列',
  status: 'available',
  variants: [
    variant('gen1', '一代（R50/R52/R53）', 'K-Line（ISO 9141-2 / ISO 14230 KWP2000）', false, ['R50', 'R53', 'R52']),
    variant(
      'gen2',
      '二代（R55–R61）',
      'CAN（ISO 15765-4，500 kbit/s）',
      true,
      ['R56', 'R55', 'R57', 'R58', 'R59', 'R60', 'R61'],
    ),
  ],
  features: [
    { name: '读取 / 清除故障码（标准 OBD）', status: 'ready' },
    { name: '实时数据流', status: 'ready' },
    { name: 'VIN / 标定号 / CVN', status: 'ready' },
    { name: '读取全车模块故障（ABS、气囊、车身等）', status: 'planned', note: '需 K+DCAN，开发中' },
    { name: '隐藏功能编码', status: 'planned', note: '需宝马私有协议，开发中' },
    { name: 'ECU 刷写（动力程序）', status: 'planned', note: '需 seed/key + 校验和，验证后开放' },
  ],

  identify(elm: Elm327, _obd: ObdService): Identification {
    return identifyMini(elm.info?.isCan ?? true);
  },

  analyzeVin(vin: string): VinAnalysis {
    const g = guessFromVin(vin);
    return {
      belongsToModule: g.isMini,
      variantId: g.generation === 1 ? 'gen1' : g.generation === 2 ? 'gen2' : null,
      note: g.note,
    };
  },

  describeDtc(code: string): string | null {
    if (MINI_DTC[code]) return MINI_DTC[code];
    const generic = describeGeneric(code);
    return generic;
  },

  // flash 暂未提供 —— 刷写窗口已在框架里预留，待真车验证后填入 FlashProvider
  flash: undefined,
};

/** 根据物理层识别 MINI 变体 */
export function identifyMini(isCan: boolean): Identification {
  return isCan
    ? { variantId: 'gen2', isCan: true, note: '检测到 CAN，判断为二代（R55–R61）' }
    : { variantId: 'gen1', isCan: false, note: '检测到 K-Line，判断为一代（R50/R52/R53）' };
}
