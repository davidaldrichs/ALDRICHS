# 06 · 开源 seed/key / 刷写调研结论

（完整版见 `docs/ecu-flashing-research.md`，这里是精简结论。来源都是公开仓库，验证过能访问。）

## 原厂程序从哪来

**不从网上下载盗版**。BMW/MINI 原厂刷写数据(ISTA/psdzdata)是版权内容，盗版对不上车会变砖。正确来源：**从车上读出来**（备份），读出的就是和这辆车匹配的原厂程序。MINI/宝马因 RSA，读取常需 **boot 模式/台架**（绕过 seed/key 直接读 flash）。

## 各品牌开源解锁情况

| 平台 | 开源解锁 | 本项目 |
|---|---|---|
| 大众 VAG | ✅ SA2（MIT） | 已实现并用官方测试向量验证（sa2.ts） |
| 奔驰 Daimler | ✅ 线性算法（MIT） | 已移植，自洽验证，未实车校准（daimler.ts） |
| 标致/雪铁龙 PSA | ✅（GPL-3.0） | 未采用（GPL 传染许可） |
| 捷豹路虎 JLR | ❌ 只有配置表无算法 | 无 |
| MINI / BMW | ❌ 私有，新款 RSA | 无，需台架逆向（RSA 可能逆不出） |

## 关键开源项目（可参考）

- **bri3d/VW_Flash**（576★）：大众 Simos/MED17 UDS 刷写，含压缩/加密/校验和，手机刷写事实标准。
- **bri3d/sa2_seed_key**（MIT）：大众 SA2 算法，本项目 sa2.ts 的来源，有 2 个测试向量。
- **dspl1236/VAGFlasher**（MIT）：开源大众 ECU 刷写。
- **jglim/UnlockECU**（MIT，463★）：主要奔驰 + 通用算法；本项目 daimler.ts 的来源。无 BMW/MINI。
- **ludwig-v/psa-seedkey-algorithm**（GPL，120★）：标致/雪铁龙完整算法（未采用）。
- **pylessard/python-udsoncan**（746★）：UDS 协议栈参考。
- **variousdemeanors/tricore-bsl-engine**：TriCore 芯片级读取（台架，有变砖风险）。
- **matiss/motronic-checksum**：Bosch Motronic 校验和。
- **RomRaider/RomRaider**、**LibreTuner/LibreTuner**：开源调校 + ECU 定义文件思路。
- **TunerPro XDF** 格式：map 定义，本项目 map-def.ts 解析其子集；社区有大量各车型 XDF。

## BMW/MINI 为什么解锁拿不到（确认过）

- 新款（MG1/MD1，B48/B58 等）：RSA 签名，私钥锁在 ECU bootloader，**从外部数学上推不出**（多来源确认：UnlockECU issue #8、MSS6x-Flasher）。
- 老款 ME 系列：未公开的非线性 16 位算法。
- BMW 逆向项目（therudywolf/MS4X）里没有 seed/key，只做刷写校验。
- → 这就是为什么 MINI/宝马解锁标 unsupported，且不是"没做"，是开源真没有。

## 实务结论（给路线）

- 要先在真车上验证整条链路，**大众最现实**：SA2 已验证、资料最全。做"A. 把 UDS 接真实连接" + 从 FRF/ODX 拿脚本和地址即可。
- MINI/宝马要真解锁，只能弄备用 ECU 上台架逆向，且新款 RSA 可能逆不出——这条要对用户讲清楚，别承诺做不到的事。
