import { sa2Algorithm } from '../platform/sa2';
import { registerDemoFlash } from './demo-flash';
import type { SubModel, Variant, VehicleModule, VinAnalysis } from '../platform/vehicle-module';

/**
 * 大众集团（VAG：大众 / 奥迪 / 斯柯达 / 西雅特）车型模块。
 *
 * 诊断走标准 OBD。解锁用 SA2（platform/sa2.ts，开源移植且用官方测试向量验证过）——
 * SA2 是每款 ECU 自带的一段脚本,存在刷写数据（FRF/ODX）里；拿到脚本就能算 key。
 * 这是本项目里第一个**解锁算法经过测试向量验证**的平台,最适合先在真车上跑通整条链路。
 */

const PETROL: SubModel[] = [
  { code: 'EA211', name: '1.0/1.4/1.5 TSI（Golf/Polo/A3 等）', years: '2012–', powertrains: [{ code: 'EA211', desc: 'TSI', ecu: 'Bosch MED17.5 / MG1CS001' }] },
  { code: 'EA888', name: '1.8/2.0 TSI（GTI/A4/Passat 等）', years: '2008–', powertrains: [{ code: 'EA888', desc: 'Gen2/Gen3 2.0T', ecu: 'Bosch MED17.5 / Simos18 / MG1' }] },
  { code: 'EA839', name: '3.0 TFSI V6', years: '2016–', powertrains: [{ code: 'EA839', desc: '3.0 TFSI', ecu: 'Bosch MG1' }] },
];

const DIESEL: SubModel[] = [
  { code: 'EA189', name: '2.0 TDI（老款,EA189）', years: '2008–2015', powertrains: [{ code: 'EA189', desc: '2.0 TDI', ecu: 'Bosch EDC17C46 / C64' }] },
  { code: 'EA288', name: '2.0 TDI（EA288）', years: '2012–', powertrains: [{ code: 'EA288', desc: '2.0 TDI', ecu: 'Bosch EDC17C74 / MD1' }] },
  { code: 'EA897', name: '3.0 V6 TDI', years: '2010–', powertrains: [{ code: 'EA897', desc: '3.0 TDI', ecu: 'Bosch EDC17CP / MD1' }] },
];

function variant(id: string, label: string, subModels: SubModel[]): Variant {
  return { id, label, protocol: 'CAN（ISO 15765-4 / UDS，SA2 安全访问）', isCan: true, subModels };
}

const VAG_WMI = ['WVW', 'WV1', 'WV2', '1VW', '3VW', '9BW', 'WAU', 'WA1', 'TRU', 'TMB', 'TMP', 'VSS', 'VSZ'];

export const vw: VehicleModule = {
  id: 'vw',
  brand: 'VW',
  name: '大众集团（VAG）',
  status: 'available',
  variants: [variant('petrol', '汽油（TSI/TFSI）', PETROL), variant('diesel', '柴油（TDI）', DIESEL)],
  features: [
    { name: '读取 / 清除故障码（标准 OBD）', status: 'ready' },
    { name: '实时数据流', status: 'ready' },
    { name: 'VIN / 标定号 / CVN', status: 'ready' },
    { name: '一键解锁（SA2）', status: 'ready', note: '算法经官方测试向量验证；真车需该 ECU 的 SA2 脚本（在刷写数据里）' },
    { name: '一键备份 / 恢复', status: 'planned', note: '解锁已就绪，备份/写入待真车验证' },
    { name: '编码 / 调校', status: 'planned', note: '解锁已就绪，写入待真车验证' },
  ],

  analyzeVin(vin: string): VinAnalysis {
    const v = vin.trim().toUpperCase();
    const isVag = VAG_WMI.some((w) => v.startsWith(w));
    return {
      belongsToModule: isVag,
      variantId: null,
      note: isVag ? '识别为大众集团 VIN' : '不是 VAG 的 VIN（常见前缀 WVW 大众 / WAU 奥迪 / TMB 斯柯达）',
    };
  },
};

// 演示模式：模拟一台用 SA2 保护的 VAG ECU。
// 它的“脚本”用 SA2 官方测试向量 1（已知正确）；模块把同一脚本作为候选,
// 所以一键解锁用真实的 SA2 算法一次命中——演示的是经过验证的 SA2,不是占位。
const DEMO_SA2_SCRIPT = [
  0x68, 0x02, 0x81, 0x49, 0x93, 0xa5, 0x5a, 0x55, 0xaa, 0x4a, 0x05, 0x87, 0x81, 0x05, 0x95, 0x26,
  0x68, 0x05, 0x82, 0x49, 0x84, 0x5a, 0xa5, 0xaa, 0x55, 0x87, 0x03, 0xf7, 0x80, 0x6a, 0x4c,
];
const demoSa2 = sa2Algorithm('vag-sa2-demo', 'VAG SA2（示例脚本）', DEMO_SA2_SCRIPT);
registerDemoFlash('vw', { secret: demoSa2, candidates: [demoSa2], seedLen: 4 });
