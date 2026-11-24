import { MemoryTuningProvider, type TuningProvider, type TuningSetting } from '../platform/tuning';

/**
 * 演示模式的编码/调校项。真车上这些值在 ECU 标定里,改它需要解锁+刷写;
 * 这里只在内存里演示“隐藏功能”和“大循环温度调整”的界面与流程。
 */
const DEMO_SETTINGS: TuningSetting[] = [
  // 隐藏功能(编码开关)
  { id: 'hidden.startup_logo', name: '隐藏:启动显示发动机水温', type: 'toggle', default: false, note: '仪表启动时多显示一项,纯演示' },
  { id: 'hidden.fold_mirror', name: '隐藏:锁车自动折叠后视镜', type: 'toggle', default: false },
  { id: 'hidden.drl', name: '隐藏:日间行车灯常亮', type: 'toggle', default: true },
  // 大循环温度(节温器/风扇目标温度)
  {
    id: 'cooling.large_circulation_temp',
    name: '大循环开启温度(节温器目标)',
    type: 'number',
    unit: '°C',
    min: 85,
    max: 110,
    step: 1,
    default: 105,
    note: '调低让发动机更早进大循环、水温更低。过低会影响暖机排放和油耗。',
  },
  {
    id: 'cooling.fan_on_temp',
    name: '电子风扇开启温度',
    type: 'number',
    unit: '°C',
    min: 85,
    max: 110,
    step: 1,
    default: 100,
  },
];

const byModule = new Map<string, TuningProvider>();

/** 取某品牌的演示调校项(每个品牌独立一份,值在会话内保留) */
export function demoTuningFor(moduleId: string): TuningProvider {
  let p = byModule.get(moduleId);
  if (!p) {
    p = new MemoryTuningProvider(DEMO_SETTINGS.map((s) => ({ ...s })));
    byModule.set(moduleId, p);
  }
  return p;
}
