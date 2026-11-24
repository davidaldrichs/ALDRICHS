import { registerDemoFlash } from './demo-flash';
import type { SeedKeyAlgorithm } from '../platform/seedkey';
import type { SubModel, Variant, VehicleModule, VinAnalysis } from '../platform/vehicle-module';

/**
 * 捷豹路虎（Jaguar Land Rover）车型模块。
 *
 * 按车型年款分三代（2014 / 2017 / 2020）——这几年 JLR 的 ECU 和安全访问换过代。
 * 诊断（读/清故障码、实时数据、VIN）走标准 OBD,真车可用。
 * ⚠️ 解锁：开源里没有 JLR 的 seed/key 算法（唯一相关的仓库只有配置表,无算法）。
 *    2020 代的 Bosch MG1/MD1 和宝马同代,很可能是 RSA 签名,从外部推不出来。
 *    所以 JLR 的一键解锁在演示里会如实报“需要逆向”,真车同样待逆向。
 */

const ERA_2014: SubModel[] = [
  { code: 'AJ126', name: '3.0 V6 机械增压汽油（F-Type/XF/XJ）', years: '2013–2017', powertrains: [{ code: 'AJ126', desc: '3.0 SC V6', ecu: 'Bosch MED17.8' }] },
  { code: 'AJ133', name: '5.0 V8 机械增压（XKR/RR Sport SVR）', years: '2009–2017', powertrains: [{ code: 'AJ133', desc: '5.0 SC V8', ecu: 'Bosch MED17.8' }] },
  { code: '306DT', name: '3.0 V6 柴油（Range Rover/Discovery）', years: '2010–2018', powertrains: [{ code: '306DT', desc: '3.0 TDV6/SDV6', ecu: 'Bosch EDC17CP11 / CP42' }] },
  { code: '224DT', name: '2.2 四缸柴油（Evoque/Freelander）', years: '2011–2016', powertrains: [{ code: '224DT', desc: '2.2 eD4/TD4/SD4', ecu: 'Bosch EDC17' }] },
];

const ERA_2017: SubModel[] = [
  { code: 'AJ200D', name: '2.0 Ingenium 四缸柴油', years: '2015–2020', powertrains: [{ code: 'AJ200D', desc: '2.0 Ingenium D', ecu: 'Bosch EDC17 / MD1' }] },
  { code: 'AJ200P', name: '2.0 Ingenium 四缸涡轮汽油', years: '2017–2020', powertrains: [{ code: 'AJ200P', desc: '2.0 Ingenium P', ecu: 'Bosch MED17 / MG1' }] },
  { code: '306DT', name: '3.0 V6 柴油', years: '2015–2019', powertrains: [{ code: '306DT', desc: '3.0 TDV6/SDV6', ecu: 'Bosch EDC17CP42' }] },
  { code: 'AJ126', name: '3.0 V6 机械增压汽油', years: '2015–2019', powertrains: [{ code: 'AJ126', desc: '3.0 SC V6', ecu: 'Bosch MED17.8' }] },
];

const ERA_2020: SubModel[] = [
  { code: 'AJ300-I6', name: '3.0 Ingenium 直六 MHEV（汽油/柴油）', years: '2019–', powertrains: [{ code: 'AJ300', desc: '3.0 I6 MHEV', ecu: 'Bosch MG1CS201 / MD1（RSA 签名）' }] },
  { code: 'AJ200-MHEV', name: '2.0 Ingenium MHEV/PHEV', years: '2019–', powertrains: [{ code: 'AJ200', desc: '2.0 Ingenium', ecu: 'Bosch MG1 / MD1（RSA 签名）' }] },
  { code: 'AJ133', name: '5.0 V8 机械增压（延用）', years: '2019–2022', powertrains: [{ code: 'AJ133', desc: '5.0 SC V8', ecu: 'Bosch MED17' }] },
];

function variant(id: string, label: string, subModels: SubModel[]): Variant {
  return { id, label, protocol: 'CAN（ISO 15765-4 / UDS，新款部分走 DoIP）', isCan: true, subModels };
}

const JLR_WMI = ['SAJ', 'SAL', 'SAD', 'SAE'];

export const jlr: VehicleModule = {
  id: 'jlr',
  brand: 'JLR',
  name: '捷豹路虎',
  status: 'available',
  variants: [
    variant('y2014', '2014 代（2010–2015）', ERA_2014),
    variant('y2017', '2017 代（Ingenium，2015–2019）', ERA_2017),
    variant('y2020', '2020 代（MHEV，2019+）', ERA_2020),
  ],
  features: [
    { name: '读取 / 清除故障码（标准 OBD）', status: 'ready' },
    { name: '实时数据流', status: 'ready' },
    { name: 'VIN / 标定号 / CVN', status: 'ready' },
    { name: '一键解锁（seed/key）', status: 'unsupported', note: '开源无 JLR 算法；2020 代 MG1/MD1 疑为 RSA，需逐 ECU 逆向' },
    { name: '一键备份 / 恢复', status: 'planned', note: '需先有解锁或走 boot 模式' },
  ],

  analyzeVin(vin: string): VinAnalysis {
    const v = vin.trim().toUpperCase();
    const isJlr = JLR_WMI.some((w) => v.startsWith(w));
    return {
      belongsToModule: isJlr,
      variantId: null,
      note: isJlr ? '识别为捷豹路虎 VIN' : '不是 JLR 的 VIN（常见前缀 SAJ 捷豹 / SAL 路虎）',
    };
  },
};

// 演示模式：模拟一台 JLR ECU，但它的“私钥算法”故意不在算法库里——
// 一键解锁会试一圈然后如实报告“需要逆向”,准确反映 JLR 的真实情况。
const jlrUnknownSecret: SeedKeyAlgorithm = {
  id: 'jlr-unknown',
  label: 'JLR 私有（未公开）',
  compute: (seed) => seed.map((b) => (b + 7) & 0xff),
};
registerDemoFlash('jlr', { secret: jlrUnknownSecret, seedLen: 4 }); // candidates 默认用通用库,必然不匹配
