# ECU 刷写调研与路线图

调研时间：2026-11。结论用于指导本项目“全平台刷写框架”的后续开发。

## 1. 原厂程序从哪来

**不从网上下载。** BMW/MINI 的原厂刷写数据（ISTA/SDP、psdzdata）是宝马的版权内容，只通过经销商授权系统分发；网上流传的都是盗版，本项目不使用。而且下载来的程序版本未必和车上的 ECU 硬件、软件号对得上，刷下去容易变砖。

**从车上读。** 正确做法是先把这辆车 ECU 里的原厂程序读出来存档。读出来的就是和这辆车 100% 匹配的原厂程序。所有正规刷写工具（开源的 VW_Flash，商业的 FoxFlash、KT200 等）都遵循“先读原厂 → 再改 → 再写”的流程，手里永远保留这辆车的原始备份。

## 2. 开源项目现状

| 项目 | 用途 | 对本项目的价值 |
| --- | --- | --- |
| [bri3d/VW_Flash](https://github.com/bri3d/VW_Flash) | 大众 Simos/MED17 的 UDS 刷写，含压缩、加密、校验和修正 | 最成熟的开源刷写范例，流程和校验和思路可以直接参考 |
| [HowIGotHere/ZephyrFlasher](https://github.com/HowIGotHere/ZephyrFlasher) | VW_Flash 的 iOS 移植 | 手机刷写的先例 |
| [dspl1236/VAGFlasher](https://github.com/dspl1236/VAGFlasher) | 开源大众 ECU 刷写（ME17 / MED9 / ME7 / EDC17），不联网不订阅 | 结构清晰，可读出到文件 |
| [variousdemeanors/tricore-bsl-engine](https://github.com/variousdemeanors/tricore-bsl-engine) | TriCore TC1767 芯片级 CAN 引导读取 / 备份 | 理论上适用于任何 TC1767 ECU；需要拆 ECU 上台架，未在 MEVD17 上实测，写入有变砖风险 |
| [matiss/motronic-checksum](https://github.com/matiss/motronic-checksum) | Bosch Motronic 校验和修正 | 校验和算法参考 |
| [pylessard/python-udsoncan](https://github.com/pylessard/python-udsoncan) | UDS（ISO 14229）完整实现 | 协议栈参考 |
| [natanaelfejes/kline](https://github.com/natanaelfejes/kline) | Rust 版 K-Line / KWP2000 | MINI 一代 K-Line 参考 |
| [RomRaider/RomRaider](https://github.com/RomRaider/RomRaider)、[LibreTuner/LibreTuner](https://github.com/LibreTuner/LibreTuner) | 开源调校，ECU 定义文件 | “用定义文件描述每种 ECU”的架构思路 |
| [zer02dev/BimmerDaten](https://github.com/zer02dev/BimmerDaten)、[radelbro/BimmerDis](https://github.com/radelbro/BimmerDis) | BMW EDIABAS / NCS 数据解析 | MINI 编码（非刷写）参考 |
| [CaringCaribou/caringcaribou](https://github.com/CaringCaribou/caringcaribou) | CAN 总线探测 | 逆向新车型时扫描 ECU 和服务 |

**MINI / BMW 没有现成的开源刷写器。** 针对 MEVD17 / MED17 读写、seed/key、校验和修正的成熟方案都是收费工具（FormulaFlash、BitBox、FoxFlash、KT200 等）。

## 3. MINI R 系列的 ECU

| 代 | 发动机 | ECU | 芯片 | 刷写难度 |
| --- | --- | --- | --- | --- |
| 一代 R50/R52/R53 | W10/W11 汽油 | Siemens EMS2000 | 较老的 MCU | 开源资料极少 |
| 二代 R55–R61 | N12/N16 汽油 | Siemens MEV17 / MEV17.2 | — | 开源资料少 |
| 二代 R55–R61 | N14/N18 汽油 | Bosch MED17.2 / MEVD17.2.2 | Infineon TriCore | 有商业工具，无开源 |
| 二代 R55–R61 | 柴油 | Bosch EDC16C34 / EDC17 | TriCore（EDC17） | 有商业工具，无开源 |

注意事项：

- 不同资料对 MEVD17.2 的芯片型号说法不一（TC1767 / TC1797 / TC1793），动手前必须拆开确认实物型号。
- 这类 ECU 往往不能只靠 OBD 口完整读出全部程序，常需要“台架读”（拆下 ECU，进 boot 模式）。
- 有的版本部分区域有写保护，需要先读出密码。
- 参考：[FormulaFlash 台架读写 MEVD17.2.3](https://formulaflash.org/formulaflash-read-write-bmw-mevd17-2-3-ecu-on-bench-successfully/)、[FoxFlash/KT200 克隆 MEDC17](https://www.obdexpress.co.uk/service/clone-bosch-medc17-with-foxflash-kt200.html)。以上均为厂商或论坛资料，未经独立验证。

## 4. “傻瓜刷写”的设计

按钮可以做到“一键”，但难的不是按钮，而是每种 ECU 的 seed/key、内存布局、校验和，以及一份经过验证的程序。框架已经把通用部分做好，各车型只需补上差异：

```
一键备份：识别 ECU → 编程会话 → seed/key 解锁 → 分块读出 → 存 .mrbk（含 VIN、标定号、SHA-256）
一键恢复：校验文件 → 核对是不是这辆车 → 检查电压 → 自动备份当前程序 → 写入 → 修正校验和 → 读回逐字节核对 → 复位
```

内置的防呆保护：

- 备份文件记录 VIN 和 SHA-256。文件损坏、换了车、换了 ECU 型号，都会拒绝恢复。
- 电压低于 12.5V 时拒绝写入。
- 写入前自动备份当前程序，写完读回逐字节比对。
- 读写过程中禁止断开连接、禁止读取仪表数据（防止和读写抢通讯）。

## 5. 路线图

1. **已完成**：通用刷写流程（`FlashRunner`）、备份文件格式（`.mrbk`）、一键备份/恢复界面、演示模式下的模拟 ECU（`DemoFlashProvider`），并有测试覆盖。
2. **下一步，二选一**：
   - **大众 MQB**：照 VW_Flash 实现第一个真·刷写模块，开源资料最全，最有可能先在真车上跑通。
   - **MINI 二代**：准备一块备用 MEVD17/MED17 ECU 和台架，确认芯片型号；先实现“只读备份”，验证 seed/key 和内存布局。
3. **再往后**：改程序（调校）。注意：修改动力程序会影响排放合规、年检和质保。

## 补充：一键解锁（seed/key）实现

已实现一个通用的 security access 引擎（`src/platform/security-access.ts`）：

- 完整的 UDS/KWP 握手（27 01 请种子 → 27 02 发密钥），处理各种否定响应：密钥错误(0x35)、超次(0x36)、需等待(0x37)、条件不满足(0x22) 等。
- 遇到“需等待”自动暂停后重试同一算法；有尝试次数上限，避免把真车 ECU 锁死。
- 密钥算法库（`src/platform/seedkey.ts`）：一键解锁按顺序逐个试。目前收录的是**通用/公开**算法族（恒等、取反、异或常量、移位、字节交换等），**不是**任何厂家的私有密钥。
- 某款 ECU 的真实算法在台架上逆出来后，作为一条新算法加进算法库即可，一键解锁立刻生效。

演示模式下有一个模拟的带 seed/key 保护的 ECU（`SimSeedKeyEcu`），用算法库里的一个算法当“私钥”，一键解锁能真实地试出它——整条引擎在演示模式就是真的在跑。

真车（尤其 MINI 二代 MEVD17）的私有算法仍需逆向，这一步没有捷径。

## 更新（2026-11）：到网上找开源解锁的结论

去 GitHub 和网络系统查了一轮：

**MINI / BMW：开源里没有,而且部分从原理上就拿不到。**
- 新款 BMW/MINI（MEVD17、MG1、MD1 这一代）用 RSA 签名,私钥锁在 ECU 自己的 bootloader 里,外部无法推导（[UnlockECU issue #8](https://github.com/jglim/UnlockECU/issues/8)、[MSS6x-Flasher](https://github.com/terraphantm/MSS6x-Flasher)）。
- 老款 ME 系列是未公开的非线性 16 位算法。
- [therudywolf/MS4X](https://github.com/therudywolf/MS4X)（BMW MS42/MS43 逆向）里没有 seed/key,只做刷写校验。
- **对 MINI 的现实意义**：备份原厂程序应走 **boot 模式 / 台架读**,直接读 flash 芯片,根本不经过 seed/key 解锁。要改程序才需要解锁,而那一步 MINI 没有开源捷径。

**开源里真实存在的解锁算法（都不是 MINI）：**
- [ludwig-v/psa-seedkey-algorithm](https://github.com/ludwig-v/psa-seedkey-algorithm)（GPL-3.0）：标致/雪铁龙/欧宝,完整算法。GPL 会传染本项目许可,未采用。
- [jglim/UnlockECU](https://github.com/jglim/UnlockECU)（MIT,463★）：主要是奔驰 + 通用算法（VolkswagenSA2、Bosch/Conti 等）,无 BMW/MINI。
- [bri3d/sa2_seed_key](https://github.com/bri3d/sa2_seed_key)（MIT）：大众/奥迪 SA2。**已移植到 `src/platform/sa2.ts` 并用它的两个官方测试向量验证通过**。

**已落地**：VAG SA2 解释器（`src/platform/sa2.ts`）。SA2 是一段每款 ECU 自带的字节码脚本,从该 ECU 的刷写数据（FRF/ODX）里取出脚本即可算 key。这是框架里第一个真实可用的解锁算法,等接入大众车型模块后,一键解锁对 VAG 就是真的。

**结论**：MINI 一键解锁无法从开源填入,只能在备用 ECU 上逆向（且新款受 RSA 限制可能逆不出可用的 key）。VAG 则已具备真实解锁能力,是先在真车上验证整条链路的最佳选择。

## 更新：奔驰 / 捷豹路虎

**奔驰（Mercedes / Daimler）：开源覆盖最好,算法已移植。**
- [jglim/UnlockECU](https://github.com/jglim/UnlockECU)（MIT）里奔驰的 seed/key 是自包含的线性算法（LCG + 异或私钥）,不像 BMW 那样 RSA 锁死。
- 已移植到 `src/platform/daimler.ts`,三个变体（standard / refG / mod）。
- ⚠️ 没有公开测试向量,只做了自洽/反推验证,未在真车核对。每台车的 K（私钥）要从该 ECU 定义数据取,或从一对已知 (seed,key) 反推（算法固有弱点）。

**捷豹路虎（JLR）：开源里基本没有。**
- 唯一相关的 [Ra3mbl/JLR-ECU-Bruteforcer](https://github.com/Ra3mbl/JLR-ECU-Bruteforcer) 只有一个 XML 配置表（各模块的安全等级、访问 DID）,**没有算法、没有代码**。
- 没有公开的 JLR seed/key 算法,只能逐 ECU 逆向。

**不做的事**：不实现通用的 security access 暴力破解工具（对任意车强行绕过解锁 = 偷车/非法改装手法）。现有“一键解锁”只试已知的公开算法并有次数上限,与暴力穷举钥匙空间是两回事。

### 各平台开源解锁对照

| 平台 | 开源解锁 | 本项目状态 |
| --- | --- | --- |
| 大众 VAG | ✅ SA2（MIT） | 已实现并用官方测试向量验证（sa2.ts） |
| 奔驰 Daimler | ✅ 线性算法（MIT） | 已移植,自洽验证,待真车核对（daimler.ts） |
| 标致/雪铁龙 PSA | ✅（GPL） | 未采用（GPL 传染许可） |
| 捷豹路虎 JLR | ❌ 仅配置表 | 无算法,需逐 ECU 逆向 |
| MINI / BMW | ❌ 私有,新款 RSA | 无,备份走 boot 模式绕过 |
