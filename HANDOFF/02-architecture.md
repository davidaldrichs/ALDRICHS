# 02 · 架构与文件说明

## 设计思想

通用流程写一次，各品牌的差异做成**可插拔的车型模块**。连接层、协议层、刷写流程、记录、调校都是品牌无关的；每个品牌只实现一个 `VehicleModule`。加新品牌 = 新建一个模块文件 + 在注册表里注册一行，其它都不用动。

分层：
```
UI (src/main.ts, index.html, src/ui/styles.css)
   │
车型模块 (src/modules/*)  ← 每个品牌一个，实现 VehicleModule
   │
平台/框架 (src/platform/*) ← 通用能力：解锁引擎、UDS、刷写流程、备份格式、map、调校、AI
   │
核心协议 (src/core/*)      ← ELM327、OBD-II、数据记录
   │
连接层 (src/transport/*)   ← 蓝牙BLE / WiFi / 串口 / 模拟器
```

## 每个文件干什么

### 连接层 `src/transport/`
- `transport.ts` — `Transport` 接口（open/close/write/onData/onClose）+ 事件辅助。所有连接方式都实现它。
- `ble.ts` — 手机蓝牙 BLE（Capacitor），自动识别 ELM327 的串口服务。
- `wifi.ts` — 手机 WiFi（capacitor-tcp-socket），连 ELM327 热点。
- `desktop-api.ts` — Electron 注入的 `window.desktop` 接口定义（isDesktop/串口/TCP/AI 转发）。
- `desktop-serial.ts` — 电脑串口/经典蓝牙(COM)，用 Web Serial。
- `desktop-wifi.ts` — 电脑 WiFi，走 Electron 主进程的 net。
- `simulator.ts` — 模拟 ELM327 + MINI ECU（OBD 诊断的演示数据，一代 K-Line / 二代 CAN 两种格式）。

### 核心协议 `src/core/`
- `elm327.ts` — ELM327 驱动：命令队列、响应清理、CAN 多帧(ISO-TP)解析。
- `obd.ts` — OBD-II 服务：实时数据(PIDS 表)、故障码(03/07/0A)、清码(04)、VIN/CALID/CVN(09)。
- `dtc-db.ts` — 通用故障码中文说明（通用 + MINI 常见原因）。
- `mini.ts` — MINI R 底盘/发动机/ECU 资料 + VIN 年款识别（给 mini-r 模块用）。
- `logger.ts` — 数据记录引擎：手动/自动触发、tick 采集、CSV 导出。纯逻辑，可测。

### 平台/框架 `src/platform/`
- `vehicle-module.ts` — **核心抽象**：`VehicleModule`、`FlashProvider`、`FlashContext`、变体/子型号类型。
- `flash-runner.ts` — 通用刷写流程调度：进会话→解锁→备份→擦写→校验和→读回校验→复位，含刷前电压检查。
- `backup-file.ts` — `.mrbk` 备份格式（含 VIN/标定号/SHA-256）+ 防刷错车检查。
- `security-access.ts` — **seed/key 解锁引擎**：UDS/KWP 27 握手，自动试算法，否定响应处理，防锁定(尝试上限+0x37等待重试)。
- `seedkey.ts` — 通用/公开算法库（恒等/异或/移位等，**非厂家私钥**）+ 类型 `SeedKeyAlgorithm`。
- `sa2.ts` — **大众 SA2** 解锁(字节码解释器，MIT 移植自 bri3d/sa2_seed_key，官方测试向量验证)。
- `daimler.ts` — **奔驰 Daimler** 解锁(线性算法，MIT 移植自 jglim/UnlockECU，自洽验证)。
- `uds.ts` — **真实 UDS 刷写协议**：`UdsClient`(各服务) + `UdsFlashProvider`(真车可用的刷写实现，参数化)。
- `uds-sim.ts` — 模拟 UDS ECU（演示/测试），真实回应各 UDS 服务。
- `tuning.ts` — 编码/调校模型：`TuningSetting`(开关/数值+范围) + `TuningProvider` + `MemoryTuningProvider`。
- `ai-tuning.ts` — **AI 调校顾问**：`proposeTuning`，AI 只在有范围的参数内建议，强制钳制，返回 from→to 对照。
- `ai-client-http.ts` — AI 接口客户端（OpenAI 兼容 / Anthropic），桌面走 Electron 转发避 CORS。
- `map-def.ts` — **标定 map(XDF)**：解析 XDF 子集、公式求值、线性化、从 ROM 读 map、写回(线性+范围钳制)。

### 车型模块 `src/modules/`
- `registry.ts` — 模块注册表 + `getModule/availableModules/reservedModules`。**加品牌改这里**。
- `mini-r.ts` — MINI R（一代/二代，K-Line/CAN；解锁 RSA 无）。
- `mercedes.ts` — 奔驰（OM柴油/M汽油/AMG；Daimler 解锁；注册了 Daimler 演示 ECU）。
- `bmw.ts` — 宝马（E/F/G 三系；解锁私有无；演示如实失败）。
- `jlr.ts` — 捷豹路虎（2014/2017/2020 三代；解锁开源无；演示如实失败）。
- `vw.ts` — 大众集团（TSI/TDI + 奥迪 V6/V8；SA2 解锁；演示用真实 UDS+SA2 模拟 ECU）。
- `demo-flash.ts` — 演示模式的模拟刷写 ECU（`DemoFlashProvider` + `SimSeedKeyEcu`）+ 按品牌注册(`registerDemoFlash` / `registerDemoFlashProvider` / `demoFlashFor`)。
- `demo-tuning.ts` — 演示模式的编码/调校项（大循环温度、隐藏功能等）。

### UI
- `index.html` — 页面骨架，标签页：连接/仪表/故障码/信息/记录/编码刷写/日志。
- `src/main.ts` — 所有界面逻辑（连接、诊断、仪表、记录、刷写面板、调校面板、Map 面板、AI）。**最大的文件**。
- `src/ui/styles.css` — 样式，含浅色/深色、移动端适配。

### 桌面
- `electron/main.cjs` — Electron 主进程：窗口、TCP(net)、串口选择、AI fetch 转发。
- `electron/preload.cjs` — 向页面暴露 `window.desktop`。

### 文档
- `docs/ecu-flashing-research.md` — 开源 ECU 刷写/解锁调研(持续更新)。
- `README.md` — 项目说明。
- `HANDOFF/` — 本交接文件夹。

## 怎么加一个新品牌

1. 新建 `src/modules/<brand>.ts`，导出一个 `VehicleModule`（参照 `jlr.ts` 最简单、`vw.ts` 最完整）。
   - 填 `variants`（代系/平台）、`subModels`（发动机/ECU，纯资料）、`features`、`analyzeVin`。
   - 有开源解锁算法 → 像 vw.ts 那样接 `sa2Algorithm`/`daimlerAlgorithm` 并注册演示 provider。
   - 没有 → 像 jlr.ts/bmw.ts 那样 `features` 里解锁标 `unsupported`，注册一个"私钥不在算法库"的演示 secret，让演示如实失败。
2. 在 `src/modules/registry.ts` 的 `MODULES` 数组里 import + 加一行。
3. 更新 `tests/obd.test.ts` 里 `availableModules()` 的断言（它列出所有可用模块 id）。
4. 可选：加一个 `tests/<brand>.test.ts`（参照 bmw.test.ts）。

## 怎么填真车解锁/刷写（关键扩展点）

`UdsFlashProvider`（`src/platform/uds.ts`）已经是真车可用的刷写实现，只需一个 `UdsFlashConfig`：
```ts
{ regions, programmingSession, algorithms, securityRequestLevel, securitySendLevel,
  addressBytes, lengthBytes, dataFormatId, eraseRoutineId?, checksumRoutineId? }
```
- `algorithms`：该 ECU 的解锁算法（如 `sa2Algorithm(id,label,script)`，script 从该车刷写数据 FRF/ODX 提取）。
- 地址/例程 id/块大小：来自该 ECU 的刷写数据。
把它接到真实连接（用 `ObdService.query` 包一个 `SecurityAccessIO`，即 `request(hex)=>Promise<Uint8Array>`），就能对真车跑。参照 `vw.ts` 里用 `UdsSimEcu` 的接法，把 `UdsSimEcu` 换成真实 IO 即可。
