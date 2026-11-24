import type { VehicleModule } from '../platform/vehicle-module';
import { miniR } from './mini-r';
import { mercedes } from './mercedes';

/**
 * 车型模块注册表。
 *
 * MINI R 是第一个落地的模块。其它品牌先以 reserved 状态占位（预留窗口），
 * 界面会把它们显示为“即将支持”。以后要加新品牌，只需：
 *   1) 新建 src/modules/<brand>.ts，实现 VehicleModule
 *   2) 在下面的数组里把占位项换成真实模块
 * 通用的连接、诊断、刷写流程都不用改。
 */

/** 占位模块：声明“以后再说”的品牌 */
function reserved(id: string, brand: string, name: string, note: string): VehicleModule {
  return { id, brand, name, status: 'reserved', reservedNote: note, variants: [], features: [] };
}

export const MODULES: VehicleModule[] = [
  miniR,
  mercedes,
  reserved('bmw-fg', 'BMW', 'BMW F/G 底盘', '二代以后的宝马，与 MINI 同为 UDS/BMW-FAST，优先级高'),
  reserved('vw-mqb', 'VW', '大众 MQB（Simos/MED17）', 'SA2 解锁算法已实现并验证（见 platform/sa2.ts），待接入真车刷写'),
  reserved('toyota', 'Toyota', '丰田 / 雷克萨斯', 'KWP/UDS，资料多'),
  reserved('generic-obd', '通用', '任意 OBD-II 车辆', '仅标准 OBD 诊断，不含刷写'),
];

export function getModule(id: string): VehicleModule | undefined {
  return MODULES.find((m) => m.id === id);
}

export const availableModules = (): VehicleModule[] => MODULES.filter((m) => m.status !== 'reserved');
export const reservedModules = (): VehicleModule[] => MODULES.filter((m) => m.status === 'reserved');
