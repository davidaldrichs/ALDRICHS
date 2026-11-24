# MINI R 诊断

手机 App，用于 MINI R 系列（**一代** R50/R52/R53、**二代** R55/R56/R57/R58/R59/R60/R61）的 OBD 诊断。
一套代码同时生成 **安卓** 和 **iPhone** 两个版本（Capacitor + TypeScript）。

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

## 还没做的：隐藏功能编码和 ECU 刷写

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

## 代码结构

```
src/core/elm327.ts     ELM327 驱动：命令队列、响应清理、CAN 多帧解析
src/core/obd.ts        OBD-II 服务：实时数据、故障码、VIN/CALID/CVN
src/core/mini.ts       MINI R 系列底盘/发动机/ECU 资料、VIN 年款识别
src/core/dtc-db.ts     故障码中文说明
src/transport/         蓝牙 BLE、WiFi、模拟器三种连接
src/main.ts            界面逻辑
tests/obd.test.ts      测试（含一代 K-Line、二代 CAN 两种模拟车）
```
