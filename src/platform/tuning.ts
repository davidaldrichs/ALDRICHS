/**
 * 编码 / 调校框架层。
 *
 * “隐藏功能”“大循环温度”这类都是改 ECU 里的一个参数/标定值。真车要用,需要该品牌的
 * 编码/刷写协议 + 解锁(MINI 目前没有)。这里只定义通用模型和接口,各车型按需实现;
 * 演示模式用内存里的模拟 ECU 跑通界面和流程。
 *
 * 安全红线:不提供任何“删除排放设备后屏蔽排放监控故障码”之类的失效装置预设。
 */

export type TuningType = 'toggle' | 'number';

export interface TuningSetting {
  id: string;
  name: string;
  type: TuningType;
  /** number 类型:单位、范围、步长 */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** 默认/原厂值 */
  default: number | boolean;
  note?: string;
}

export interface TuningProvider {
  list(): TuningSetting[];
  get(id: string): number | boolean;
  /** 写入;超范围会被钳制或抛错 */
  set(id: string, value: number | boolean): void;
  /** 恢复某项到原厂默认 */
  reset(id: string): void;
}

/** 校验并规整一个待写入的值 */
export function normalizeValue(setting: TuningSetting, value: number | boolean): number | boolean {
  if (setting.type === 'toggle') return !!value;
  let v = Number(value);
  if (!Number.isFinite(v)) throw new Error(`${setting.name}:不是有效数字`);
  if (setting.step) v = Math.round(v / setting.step) * setting.step;
  if (setting.min !== undefined) v = Math.max(setting.min, v);
  if (setting.max !== undefined) v = Math.min(setting.max, v);
  return v;
}

/** 内存实现(演示模式用,也可作真车实现的基类) */
export class MemoryTuningProvider implements TuningProvider {
  private readonly values = new Map<string, number | boolean>();
  constructor(private readonly settings: TuningSetting[]) {
    for (const s of settings) this.values.set(s.id, s.default);
  }
  list(): TuningSetting[] {
    return this.settings;
  }
  get(id: string): number | boolean {
    const s = this.settings.find((x) => x.id === id);
    if (!s) throw new Error(`未知设置:${id}`);
    return this.values.get(id) ?? s.default;
  }
  set(id: string, value: number | boolean): void {
    const s = this.settings.find((x) => x.id === id);
    if (!s) throw new Error(`未知设置:${id}`);
    this.values.set(id, normalizeValue(s, value));
  }
  reset(id: string): void {
    const s = this.settings.find((x) => x.id === id);
    if (!s) throw new Error(`未知设置:${id}`);
    this.values.set(id, s.default);
  }
}
