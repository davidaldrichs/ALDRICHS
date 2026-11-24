# MINI R 诊断

手机 App，用于 MINI R 系列（**一代** R50/R52/R53、**二代** R55/R56/R57/R58/R59/R60/R61）的 OBD 诊断。
一套代码同时生成 **安卓** 和 **iPhone** 两个版本（Capacitor + TypeScript）。

底层是一个**可扩展的全平台刷写框架**，MINI R 是第一个车型模块，其它品牌可按同一套接口接入（见下文「架构」）。

## 现在能做什么

| 功能 | 一代（K-Line） | 二代（CAN） |
| --- | --- | --- |
| 读取故障码（已确认 / 待定 / 永久）+ 中文说明 | ✅ | ✅ |
| 清除故障码 | ✅ | ✅ |
| 实时数据：转速、车速、水温、进气温度、负荷、节气门、进气压力、增压值、MAF、点火角、燃油修正、电压、机油温度等 | ✅ | ✅ |
| VIN、标定号（CALID）、校验码（CVN）、ECU 名称 | ✅ | ✅ |
| 自动识别协议，判断是一代还是二代 | ✅ | ✅ |
| 演示模式（不接车也能体验） | ✅ | ✅ |

**连接方式**

| 适配器 | 安卓 | iPhone |
| --- | --- | --- |
| ELM327 **BLE**（蓝牙 4.0，例如 Vgate iCar Pro BLE） | ✅ | ✅ |
| ELM327 **WiFi**（热点 192.168.0.10:35000） | ✅ | ✅ |
| ELM327 经典蓝牙（SPP） | 计划中 | ❌ iPhone 系统不允许 |
| K+DCAN USB 线 | 计划中（需 OTG） | ❌ |

## 一键备份 / 恢复原厂程序

在“编码/刷写”页，连接后可以：

- **一键备份原厂程序**：读出 ECU 程序，存成 `.mrbk` 文件。文件里记录了 VIN、标定号和 SHA-256。
- **从备份恢复**：恢复前先检查文件有没有损坏、是不是这辆车的备份，再检查电压是否不低于 12.5V。确认后自动备份当前程序，再写入、修正校验和，最后读回逐字节核对。

目前只有“演示模式”（模拟 ECU）能实际体验，真车读写要等对应车型的 `FlashProvider` 验证完成后开放。原厂程序从哪来、开源现状和路线图见 [docs/ecu-flashing-research.md](docs/ecu-flashing-research.md)。

## 还没做的：隐藏功能编码和真车 ECU 刷写

这两项要用宝马私有协议（BMW-FAST / KWP2000 / D-CAN），刷写还需要通过 ECU 的安全认证（seed/key）并修正程序校验和，写错可能让 ECU 变砖、车无法启动。
所以这两项必须在真车和备用 ECU 上逐项验证后才会开放，目前 App 里只显示说明。在此之前请用成熟工具：BimmerCode（编码）、Deep OBD（开源，安卓）、专业刷写工具（刷前务必备份原厂程序，并接稳压电源）。

## 编译安装

需要 Node.js 22+。

```bash
npm install
npm test          # 运行单元测试 + 一代/二代模拟车的端到端测试
npm run dev       # 浏览器预览（只能用演示模式和 Chrome 的 Web Bluetooth）
```

**安卓**（需要 Android Studio，JDK 21）

```bash
npm run cap:sync
npx cap open android   # 在 Android Studio 里点 Run，或 Build > Build APK
```

**iPhone**（需要 Mac + Xcode 26+）

```bash
npm run cap:sync
npx cap open ios       # 在 Xcode 里选择你的开发者账号签名后运行到手机
```

蓝牙和本地网络权限已经写在 `android/app/src/main/AndroidManifest.xml` 和 `ios/App/App/Info.plist` 里。

## 使用

1. 车辆 OBD 接口在方向盘左下方，插上适配器，**打开点火开关**（或启动发动机）。
2. App 里选择底盘（一代 / 二代）和车型，选连接方式，点“连接”。
   - 一代车走 K-Line，第一次连接要初始化总线，可能要等 5–10 秒。
   - WiFi 适配器：先在手机 WiFi 设置里连上适配器热点。
3. 连接成功后可以读故障码、看仪表、读车辆信息。“日志”页可以发送只读的 AT/OBD 命令排查问题。

## Windows 电脑版（Electron）

电脑版复用同一套界面和框架，只是连接方式换成电脑常用的：

| 连接 | 说明 |
| --- | --- |
| **串口 / 经典蓝牙（COM 口）** | 经典蓝牙适配器先在 Windows 蓝牙设置里配对，会出现为一个 COM 口；USB K+DCAN 线也是 COM 口。点“连接”后在弹窗里选端口。 |
| **WiFi** | 先连接适配器的 WiFi 热点（默认 192.168.0.10:35000）。 |
| **演示模式** | 不接车也能体验。 |

**直接用**：`release/` 里的 `MINI R 诊断 0.1.0.exe` 是免安装的便携版，双击即可运行。

**自己打包**（在 Windows 上，无需 wine）：
```bash
npm install
npm run dist:win     # 生成 release/ 里的便携版和安装版 exe
```
开发时实时调试：`npm run electron:dev`。

> 说明：本仓库自带的便携 exe 是在 Linux 容器里用 wine 打包的，因容器限制未加图标和版本信息、也没有数字签名，Windows 首次运行可能提示“未知发布者”，选“仍要运行”即可。在 Windows 上用 `npm run dist:win` 自己打包就没有这些限制。

## 架构：全平台刷写框架

这个 App 不是只为 MINI 写死的，而是一个**可扩展的车型框架**。通用流程写一次，各品牌的差异做成可插拔的“车型模块”。MINI R 是第一个落地模块，其它品牌先在注册表里占位（界面显示“即将支持”）。

- **连接层**（`src/transport/`）：蓝牙 BLE、WiFi、模拟器，与品牌无关。
- **协议层**（`src/core/`）：ELM327 驱动、OBD-II 服务，与品牌无关。
- **刷写流程**（`src/platform/flash-runner.ts`）：固定步骤——进会话 → security access(seed/key) → 备份 → 擦写 → 校验和 → 复位，并强制刷前电压检查。各车型只需填 `FlashProvider` 里的差异方法。
- **车型模块**（`src/modules/`）：每个品牌一个文件，实现 `VehicleModule`（变体/底盘资料、VIN 识别、专属故障码、可选的 `FlashProvider`）。
- **注册表**（`src/modules/registry.ts`）：列出所有模块。加新品牌 = 新建一个模块文件 + 在这里注册，通用流程和界面都不用改。

**刷写为什么还是“预留窗口”**：`FlashProvider` 接口已经定义好，`FlashRunner` 的调度和安全检查也写好并有测试覆盖，但 MINI 模块的 `flash` 目前是 `undefined`——因为 seed/key 算法、内存布局、校验和算法必须在真车和备用 ECU 上验证，写错会让 ECU 变砖。验证完把 `FlashProvider` 填进 MINI 模块即可开放，框架其余部分不动。

加新品牌的步骤：
1. 新建 `src/modules/<brand>.ts`，实现 `VehicleModule`
2. 在 `src/modules/registry.ts` 把占位项换成真实模块
3. （要刷写时）实现该模块的 `FlashProvider`

## 代码结构

```
src/platform/vehicle-module.ts  框架核心：VehicleModule / FlashProvider 接口
src/platform/security-access.ts  seed/key 握手引擎（自动试算法、防锁定）
src/platform/seedkey.ts         密钥算法库（通用算法，可加逆向出的真实算法）
src/platform/flash-runner.ts    通用刷写流程调度 + 刷前安全检查 + 读回校验
src/platform/backup-file.ts     .mrbk 备份格式、防刷错车检查
src/modules/demo-flash.ts       演示模式的模拟 ECU（seed/key、校验和）
src/modules/registry.ts         车型模块注册表（MINI 可用，其它品牌预留）
src/modules/mini-r.ts           MINI R 模块：变体/底盘、VIN 识别、专属故障码
src/core/elm327.ts     ELM327 驱动：命令队列、响应清理、CAN 多帧解析
src/core/obd.ts        OBD-II 服务：实时数据、故障码、VIN/CALID/CVN
src/core/mini.ts       MINI R 底盘/发动机/ECU 资料、VIN 年款识别
src/core/dtc-db.ts     通用故障码中文说明
src/transport/         蓝牙 BLE、WiFi、模拟器三种连接
src/transport/desktop-*.ts   电脑版连接：串口(Web Serial)、WiFi(TCP)
electron/main.cjs      Electron 主进程：窗口 + TCP + 串口选择
electron/preload.cjs    向页面安全暴露桌面能力
src/main.ts            界面逻辑（注册表驱动，按平台切换连接方式）
tests/obd.test.ts      测试（协议解析 + 一/二代模拟车 + 框架）
tests/flash.test.ts    测试（备份格式、防刷错车、一键备份/恢复、电压/中断保护）
tests/unlock.test.ts   测试（seed/key 引擎：成功/锁定/无匹配/等待重试）
```
