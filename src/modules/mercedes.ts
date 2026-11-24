import { daimlerAlgorithm } from '../platform/daimler';
import { registerDemoFlash } from './demo-flash';
import type { SubModel, Variant, VehicleModule, VinAnalysis } from '../platform/vehicle-module';

/**
 * 奔驰 / 戴姆勒车型模块。
 *
 * 诊断（读/清故障码、实时数据、VIN）走标准 OBD-II，真车可用。
 * 解锁用 Daimler 算法（platform/daimler.ts，自开源移植）——真车需要这台 ECU 的 K（私钥），
 * 可从一对已知 (seed,key) 反推。演示模式下用一个已知 K 的模拟 ECU，完整演示“一键解锁”。
 */

/** OM = 柴油发动机；M = 汽油发动机 */
const DIESEL: SubModel[] = [
  { code: 'OM651', name: '2.1L 直四柴油（C/E/GLC 等）', years: '2008–2019', powertrains: [{ code: 'OM651', desc: '2.1 CDI', ecu: 'Bosch EDC17CP46 / CP57' }] },
  { code: 'OM642', name: '3.0L V6 柴油', years: '2005–2020', powertrains: [{ code: 'OM642', desc: '3.0 V6 CDI', ecu: 'Bosch EDC16CP31 / EDC17CP' }] },
  { code: 'OM654', name: '2.0L 直四柴油（新一代）', years: '2016–', powertrains: [{ code: 'OM654', desc: '2.0d', ecu: 'Bosch MD1CS001' }] },
  { code: 'OM656', name: '3.0L 直六柴油', years: '2017–', powertrains: [{ code: 'OM656', desc: '3.0d', ecu: 'Bosch MD1' }] },
];

const PETROL: SubModel[] = [
  { code: 'M271', name: '1.8L 直四汽油（增压/机械增压）', years: '2002–2015', powertrains: [{ code: 'M271', desc: '1.8 Kompressor/CGI', ecu: 'Bosch ME9.7 / MED17.7' }] },
  { code: 'M274', name: '2.0L 直四涡轮汽油', years: '2011–', powertrains: [{ code: 'M274', desc: '2.0T', ecu: 'Bosch MED17.7.x' }] },
  { code: 'M276', name: '3.0/3.5L V6 汽油', years: '2010–', powertrains: [{ code: 'M276', desc: 'V6', ecu: 'Bosch MED17.7.x' }] },
  { code: 'M133/M139', name: 'AMG 2.0L 涡轮', years: '2013–', powertrains: [{ code: 'M133', desc: 'AMG A45 等', ecu: 'Bosch MED17' }] },
];

function variant(id: string, label: string, subModels: SubModel[]): Variant {
  return { id, label, protocol: 'CAN（ISO 15765-4 / UDS）', isCan: true, subModels };
}

const MB_WMI = ['WDB', 'WDC', 'WDD', 'WDF', 'W1K', 'W1N', 'W1V', 'WME', '4JG', '55S'];

export const mercedes: VehicleModule = {
  id: 'mercedes',
  brand: 'Mercedes',
  name: '奔驰 / 戴姆勒',
  status: 'available',
  variants: [variant('diesel', '柴油（OM）', DIESEL), variant('petrol', '汽油（M）', PETROL)],
  features: [
    { name: '读取 / 清除故障码（标准 OBD）', status: 'ready' },
    { name: '实时数据流', status: 'ready' },
    { name: 'VIN / 标定号 / CVN', status: 'ready' },
    { name: '一键解锁（Daimler seed/key）', status: 'planned', note: '算法已实现；真车需该 ECU 的 K（可从一对 seed/key 反推）' },
    { name: '一键备份 / 恢复', status: 'planned', note: '框架完成，演示模式可体验；真车待验证' },
  ],

  analyzeVin(vin: string): VinAnalysis {
    const v = vin.trim().toUpperCase();
    const isMb = MB_WMI.some((w) => v.startsWith(w));
    return {
      belongsToModule: isMb,
      variantId: null, // 油/汽无法从 VIN 前缀可靠区分
      note: isMb ? '识别为奔驰 VIN' : '不是奔驰的 VIN（常见前缀 WDB/WDD/W1K 等）',
    };
  },

  // describeDtc 用通用库（不覆盖）
  // flash 真车未开放；演示模式由 demoFlashFor('mercedes') 提供
};

// 演示模式：模拟一台用 Daimler 算法保护的奔驰 ECU。
// 这台“ECU”的私钥 K 固定为 DE AD BE EF；模块“知道”K，所以一键解锁一次命中，
// 演示的是真实的 Daimler 算法（8 字节 seed → 4 字节 key）。
const DEMO_K = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
const demoDaimler = daimlerAlgorithm('mb-daimler-demo', '奔驰 Daimler（标准，示例 K）', 'standard', { K: DEMO_K });
registerDemoFlash('mercedes', { secret: demoDaimler, candidates: [demoDaimler], seedLen: 8 });
