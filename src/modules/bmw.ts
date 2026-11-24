import { registerDemoFlash } from './demo-flash';
import type { SeedKeyAlgorithm } from '../platform/seedkey';
import type { SubModel, Variant, VehicleModule, VinAnalysis } from '../platform/vehicle-module';

/**
 * 宝马（BMW）车型模块。MINI 本就是宝马集团,两者共用 ECU 和安全机制。
 *
 * 诊断（读/清故障码、实时数据、VIN）走标准 OBD,真车可用。
 * ⚠️ 解锁/刷写:和 MINI 一样是宝马私有协议,新款（B48/B58 的 Bosch MG1/MD1）是 RSA 签名,
 *    私钥锁在 ECU bootloader 里,从外部推不出。开源没有宝马 seed/key 算法。
 *    所以解锁标为“不支持”,演示里如实报“需逆向”,不假装成功。编码可借助 BimmerCode 等成熟工具。
 */

const E_SERIES: SubModel[] = [
  { code: 'N52', name: '3.0 直六自吸（E90 325i/330i, E60 等）', years: '2005–2013', powertrains: [{ code: 'N52', desc: '3.0 NA', ecu: 'Siemens MSV70 / MSV80' }] },
  { code: 'N54', name: '3.0 双涡轮（335i/135i/740i）', years: '2006–2016', powertrains: [{ code: 'N54', desc: '3.0 TwinTurbo', ecu: 'Siemens MSD80 / MSD81' }] },
  { code: 'N55', name: '3.0 单涡轮（335i/X5 等）', years: '2009–2016', powertrains: [{ code: 'N55', desc: '3.0 Turbo', ecu: 'Bosch MEVD17.2' }] },
  { code: 'M57', name: '3.0 直六柴油（330d/530d/X5）', years: '2004–2013', powertrains: [{ code: 'M57', desc: '3.0d', ecu: 'Bosch DDE EDC16/EDC17' }] },
  { code: 'S65', name: 'M3 4.0 V8（E9x M3）', years: '2007–2013', powertrains: [{ code: 'S65', desc: '4.0 V8', ecu: 'Siemens MSS60' }] },
];

const F_SERIES: SubModel[] = [
  { code: 'N20', name: '2.0 涡轮（F30 320i/328i, F10 等）', years: '2011–2017', powertrains: [{ code: 'N20', desc: '2.0 Turbo', ecu: 'Bosch MEVD17.2.4/.5' }] },
  { code: 'N55', name: '3.0 涡轮（335i/435i/M2）', years: '2011–2019', powertrains: [{ code: 'N55', desc: '3.0 Turbo', ecu: 'Bosch MEVD17.2.6/.9' }] },
  { code: 'B58', name: '3.0 涡轮（340i/440i/M140i）', years: '2015–', powertrains: [{ code: 'B58', desc: '3.0 Turbo', ecu: 'Bosch MG1CS003（RSA）' }] },
  { code: 'N57', name: '3.0 直六柴油（335d/535d/X5）', years: '2008–2019', powertrains: [{ code: 'N57', desc: '3.0d', ecu: 'Bosch EDC17CP45/CP09' }] },
  { code: 'B47', name: '2.0 柴油（118d/320d/520d）', years: '2014–', powertrains: [{ code: 'B47', desc: '2.0d', ecu: 'Bosch MD1CS001（RSA）' }] },
  { code: 'S55', name: 'M3/M4 3.0 双涡轮（F80/F82）', years: '2014–2020', powertrains: [{ code: 'S55', desc: '3.0 TT', ecu: 'Bosch MEVD17.2.9' }] },
];

const G_SERIES: SubModel[] = [
  { code: 'B48', name: '2.0 涡轮（G20 330i, G30 530i 等）', years: '2017–', powertrains: [{ code: 'B48', desc: '2.0 Turbo', ecu: 'Bosch MG1CS201（RSA）' }] },
  { code: 'B58', name: '3.0 涡轮（G20 M340i, X3 M40i 等）', years: '2017–', powertrains: [{ code: 'B58', desc: '3.0 Turbo', ecu: 'Bosch MG1CS003（RSA）' }] },
  { code: 'B57', name: '3.0 直六柴油', years: '2016–', powertrains: [{ code: 'B57', desc: '3.0d', ecu: 'Bosch MD1CP002（RSA）' }] },
  { code: 'S58', name: 'M3/M4 3.0 双涡轮（G80/G82）', years: '2021–', powertrains: [{ code: 'S58', desc: '3.0 TT', ecu: 'Bosch MG1CS024（RSA）' }] },
  { code: 'S68', name: '4.4 V8 双涡轮（M5/X5 M 等）', years: '2022–', powertrains: [{ code: 'S68', desc: '4.4 V8', ecu: 'Bosch MG1（RSA）' }] },
];

function variant(id: string, label: string, protocol: string, subModels: SubModel[]): Variant {
  return { id, label, protocol, isCan: true, subModels };
}

const BMW_WMI = ['WBA', 'WBS', 'WBX', 'WBY', 'WB4', '5UX', '5YM', '4US', 'WB1', 'WB3'];

export const bmw: VehicleModule = {
  id: 'bmw',
  brand: 'BMW',
  name: '宝马（BMW）',
  status: 'available',
  variants: [
    variant('e', 'E 系列（2004–2013）', 'CAN / 部分 K-CAN（早期）', E_SERIES),
    variant('f', 'F 系列（2011–2019）', 'CAN（ISO 15765-4 / UDS，BMW-FAST）', F_SERIES),
    variant('g', 'G 系列（2017+）', 'CAN / DoIP（UDS）', G_SERIES),
  ],
  features: [
    { name: '读取 / 清除故障码（标准 OBD）', status: 'ready' },
    { name: '实时数据流', status: 'ready' },
    { name: 'VIN / 标定号 / CVN', status: 'ready' },
    { name: '隐藏功能编码', status: 'planned', note: '需宝马编码协议（可先用 BimmerCode）' },
    { name: '一键解锁（seed/key）', status: 'unsupported', note: '宝马私有；新款 MG1/MD1 为 RSA，开源无算法，需逐 ECU 逆向' },
    { name: 'ECU 刷写 / 调马力', status: 'unsupported', note: '同上；读取备份需走 boot 模式/台架' },
  ],

  analyzeVin(vin: string): VinAnalysis {
    const v = vin.trim().toUpperCase();
    const isBmw = BMW_WMI.some((w) => v.startsWith(w));
    return {
      belongsToModule: isBmw,
      variantId: null,
      note: isBmw ? '识别为宝马 VIN' : '不是宝马的 VIN（常见前缀 WBA/WBS/WBX）',
    };
  },
};

// 演示:宝马 ECU 的私钥算法不在算法库里 → 一键解锁如实报“需逆向”,准确反映真实情况。
const bmwUnknownSecret: SeedKeyAlgorithm = {
  id: 'bmw-unknown',
  label: '宝马私有（未公开 / RSA）',
  // 刻意不等于算法库里任何通用算法,好让演示里的一键解锁如实失败
  compute: (seed) => seed.map((b) => (b * 7 + 0x11) & 0xff),
};
registerDemoFlash('bmw', { secret: bmwUnknownSecret, seedLen: 4 });
