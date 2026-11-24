# 04 · 逐功能状态 + 路线图

## 逐功能真实状态

| 功能 | 代码状态 | 演示 | 真车 | 备注 |
|---|---|---|---|---|
| 连接(蓝牙BLE/WiFi/串口/模拟) | ✅ 完成 | ✅ | 应可用 | 真车未实测 |
| 故障码 读/清 | ✅ 完成 | ✅ | 应可用 | 标准 OBD |
| 实时数据仪表 | ✅ 完成 | ✅ | 应可用 | PIDS 表在 obd.ts |
| VIN/标定号/CVN | ✅ 完成 | ✅ | 应可用 | Mode 09 |
| 故障码软件端隐藏 | ✅ 完成 | ✅ | ✅ | 仅显示层，不写 ECU |
| 数据记录 + 自动触发 + CSV | ✅ 完成 | ✅ | 应可用 | logger.ts |
| AI 生成记录方案 | ✅ 完成 | ✅(需key) | 需key | main.ts aiLogProfile |
| seed/key 解锁引擎 | ✅ 完成 | ✅ | 需算法 | security-access.ts |
| 大众 SA2 算法 | ✅ 验证(官方向量) | ✅ | 需脚本 | sa2.ts |
| 奔驰 Daimler 算法 | ✅ 移植(自洽验证) | ✅ | 需K+实车校准 | daimler.ts |
| MINI/宝马/JLR 解锁 | ❌ 开源无 | 如实失败 | ❌ | RSA/私有 |
| 真实 UDS 备份/恢复 | ✅ 完成 | ✅(大众) | 需参数 | uds.ts, 仅大众 demo 接了 |
| .mrbk 备份格式+防刷错车 | ✅ 完成 | ✅ | ✅ | backup-file.ts |
| 编码/调校(隐藏功能/大循环温度) | ✅ 框架 | ✅ | 需写入协议 | tuning.ts, demo-tuning.ts |
| AI 调校顾问(护栏) | ✅ 完成 | ✅(需key) | 需key+写入 | ai-tuning.ts |
| Map 调校(XDF 读改) | ✅ 完成 | ✅ | 需XDF+ROM | map-def.ts |
| 导出修改后 ROM | ✅ 完成 | ✅ | ✅ | main.ts map-export |

## "真车还差什么"的精确清单

要让解锁/刷写/调马力在**某一台真车**上跑通，缺的是**数据**不是代码：
1. 该 ECU 的**解锁算法**：大众=SA2 脚本(FRF/ODX 里)，奔驰=K 私钥(或从一对 seed/key 反推)。MINI/宝马/JLR=需台架逆向(新款 RSA 可能逆不出)。
2. 该 ECU 的**内存地址/大小、擦除例程id、校验例程id、块大小** → 填进 `UdsFlashConfig`。
3. 调马力还要该 ECU 的 **XDF map 定义**（社区有，如大众 EA888）。
4. **把 `UdsFlashProvider` 接到真实连接**（现在只接了演示用的 `UdsSimEcu`）。

## 路线图（按优先级）

### A. 把"读写"接到真实连接（最该先做）
现在 `UdsFlashProvider` 只在大众演示里跑（对 `UdsSimEcu`）。做一个 `ObdUdsIO`：用 `ObdService`/`Elm327` 把 `request(hex)=>Promise<Uint8Array>` 实现出来（发 UDS 请求、收响应、解析多帧），然后在连接真车时用它构造 `UdsFlashProvider`。这样大众真车就能真备份/恢复（有了脚本+地址后）。
- 注意 ELM327 对 UDS 大数据块的 ISO-TP 流控/超时，可能要配 `AT` 参数。

### B. AI 接到 map 上（用户想要的"AI 调马力"下一步）
现在 AI 顾问只对"有范围的 TuningSetting"建议。把它扩展到 **map**：对某张表（如增压目标）让 AI 在每格的范围内给调整建议，同样强制钳制 + 人工确认 + 保留备份。`ai-tuning.ts` 的模式可复用，把输入从 `TuningProvider` 换成 `MapItem` + 当前值矩阵。
- **务必保持护栏**：AI 给的值一律过 `writeMap` 的钳制，不越界，人工逐项确认。

### C. log 与 map 联动（数据驱动调校）
用记录的实际值（增压/点火等）对照 map，算偏差、标出该改的格子。比凭感觉调安全。

### D. 从 FRF/ODX 自动提取 SA2 脚本 + 地址 + 例程
这样大众/奥迪真车不用手动找参数，导入刷写文件就能拿到解锁+地址。需要解析 FRF(通常是容器，可能含 LZMA/压缩)和 ODX(XML)。

### E. 补更多品牌/发动机资料、丰田模块、通用 OBD 模块落地。

## 已知小问题 / 待办
- `downloads/` 里的 0.3.0 exe 不含宝马模块（加宝马后需重打包）。
- Linux+wine 打的 portable exe 无图标/签名（真 Windows 上打包无此问题）。
- 真车 UDS 的 ISO-TP 流控没在真车上验证过。
- XDF 解析是常见子集；字节序/符号位标志按常见约定，复杂 XDF（多轴 stride、压缩）可能要扩展。
