import type { Elm327 } from '../core/elm327';
import type { ObdService } from '../core/obd';

/**
 * 全平台刷写框架的核心抽象。
 *
 * 设计目标：通用流程（连接 → 识别 → 诊断 → 刷写）写一次，
 * 各品牌/车型的差异（协议、seed/key、内存布局、校验和）做成可插拔的“车型模块”。
 * MINI R 是第一个落地的模块，其它品牌先在注册表里占位（预留窗口）。
 */

/** 一个车型模块的实现成熟度 */
export type ModuleStatus =
  | 'available' // 已可用
  | 'preview' // 部分可用 / 实验中
  | 'reserved'; // 占位，尚未实现（预留窗口）

/** 功能项状态 */
export type FeatureStatus = 'ready' | 'planned' | 'unsupported';

export interface Feature {
  name: string;
  status: FeatureStatus;
  note?: string;
}

/** 一个“变体”：通常对应一个代系 / 平台（如 MINI 一代 / 二代） */
export interface Variant {
  id: string;
  label: string;
  /** 这一变体在 OBD 口上的通讯方式说明 */
  protocol: string;
  /** 期望的物理层：true=CAN，false=K-Line。用于连接后核对所选车型 */
  isCan: boolean;
  /** 具体车型/底盘列表，供界面选择（纯展示用） */
  subModels: SubModel[];
}

export interface SubModel {
  code: string;
  name: string;
  years: string;
  /** 常见发动机/ECU，纯展示 */
  powertrains: { code: string; desc: string; ecu: string }[];
}

/** 连接成功后，从车上读到的识别结果 */
export interface Identification {
  variantId: string | null;
  isCan: boolean;
  /** 一段给用户看的说明 */
  note: string;
}

/** VIN 分析结果 */
export interface VinAnalysis {
  belongsToModule: boolean;
  variantId: string | null;
  note: string;
}

/* -------------------------------------------------------------------------- */
/*  刷写接口（预留窗口）                                                        */
/*  通用刷写流程在 FlashRunner 里；每个车型模块只需提供下面这些“差异点”。       */
/* -------------------------------------------------------------------------- */

export interface FlashContext {
  elm: Elm327;
  obd: ObdService;
  /** 进度 0–1 与状态文本 */
  report: (progress: number, message: string) => void;
  /** 检查是否被用户取消 */
  cancelled: () => boolean;
}

export interface FlashMemoryRegion {
  name: string;
  /** 起始地址与长度（字节），用于显示和分块 */
  address: number;
  size: number;
}

/**
 * 车型刷写能力。把通用刷写流程需要的“车型私有部分”抽成方法。
 * 真正实现某个车型的刷写时，填满这些方法即可；框架负责调度和安全检查。
 */
export interface FlashProvider {
  /** 可读写的内存区（显示给用户选择要备份/刷写的部分） */
  regions: FlashMemoryRegion[];
  /** 进入编程诊断会话（例如 UDS 10 02 / KWP 启动会话） */
  enterProgrammingSession(ctx: FlashContext): Promise<void>;
  /** 通过 security access（seed/key）解锁 ECU */
  unlock(ctx: FlashContext): Promise<void>;
  /** 读取一段内存（备份原厂程序） */
  readRegion(ctx: FlashContext, region: FlashMemoryRegion): Promise<Uint8Array>;
  /** 校验要写入的固件（大小、校验和、是否匹配本车 ECU） */
  validateImage(region: FlashMemoryRegion, data: Uint8Array): Promise<void>;
  /** 擦除并写入一段内存 */
  writeRegion(ctx: FlashContext, region: FlashMemoryRegion, data: Uint8Array): Promise<void>;
  /** 写入后修正校验和 */
  finalizeChecksum(ctx: FlashContext, region: FlashMemoryRegion): Promise<void>;
  /** 复位 ECU，退出编程会话 */
  reset(ctx: FlashContext): Promise<void>;
}

/* -------------------------------------------------------------------------- */

export interface VehicleModule {
  id: string;
  brand: string;
  /** 面向用户的名字，如 “MINI R 系列” */
  name: string;
  status: ModuleStatus;
  /** 占位模块用这句话说明“以后再说” */
  reservedNote?: string;
  variants: Variant[];
  features: Feature[];

  /** 连接后识别变体（哪一代）。可用模块必须实现 */
  identify?(elm: Elm327, obd: ObdService): Identification;
  /** VIN 分析 */
  analyzeVin?(vin: string): VinAnalysis;
  /** 品牌专属的故障码说明；返回 null 则用通用数据库 */
  describeDtc?(code: string): string | null;
  /** 刷写能力；undefined = 本车型暂未开放刷写（预留） */
  flash?: FlashProvider;
}
