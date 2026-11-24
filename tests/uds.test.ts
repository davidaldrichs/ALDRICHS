import { describe, expect, it } from 'vitest';
import { UdsClient, UdsFlashProvider, type UdsFlashConfig } from '../src/platform/uds';
import { UdsSimEcu, imageChecksumOk } from '../src/platform/uds-sim';
import { sa2Algorithm } from '../src/platform/sa2';
import type { FlashContext } from '../src/platform/vehicle-module';
import { FlashRunner } from '../src/platform/flash-runner';
import { encodeBackup, decodeBackup } from '../src/platform/backup-file';

const SA2_SCRIPT = [0x68, 0x02, 0x81, 0x49, 0x93, 0xa5, 0x5a, 0x55, 0xaa, 0x4a, 0x05, 0x87, 0x81, 0x05, 0x95, 0x26, 0x68, 0x05, 0x82, 0x49, 0x84, 0x5a, 0xa5, 0xaa, 0x55, 0x87, 0x03, 0xf7, 0x80, 0x6a, 0x4c];
const algo = sa2Algorithm('sa2', 'SA2', SA2_SCRIPT);
const region = { name: 'CAL', address: 0x80040000, size: 4096 };

function setup(maxBlock = 256) {
  const ecu = new UdsSimEcu({ secret: algo, seedLen: 4, region, eraseRoutineId: 0xff00, checksumRoutineId: 0x0202, maxBlock });
  const cfg: UdsFlashConfig = {
    regions: [region], programmingSession: 0x02,
    algorithms: [algo], securityRequestLevel: 0x01, securitySendLevel: 0x02,
    addressBytes: 4, lengthBytes: 4, dataFormatId: 0x00,
    eraseRoutineId: 0xff00, checksumRoutineId: 0x0202, lockoutWaitMs: 50,
  };
  const provider = new UdsFlashProvider(new UdsClient(ecu), cfg);
  return { ecu, provider };
}
const ctx = (): FlashContext => ({ elm: { send: async () => '13.5V' } as never, obd: {} as never, report: () => {}, cancelled: () => false });

describe('真实 UDS 刷写流程（对照模拟 ECU）', () => {
  it('UDS 解锁用 SA2（34/35 前必须先 27 解锁）', async () => {
    const { provider } = setup();
    await provider.enterProgrammingSession(ctx());
    const r = await provider.probeUnlock(ctx());
    expect(r.unlocked).toBe(true);
    expect(r.algorithm?.id).toBe('sa2');
  });

  it('未解锁时 requestUpload 被拒（0x33）', async () => {
    const { provider } = setup();
    await provider.enterProgrammingSession(ctx());
    await expect(provider.readRegion(ctx(), region)).rejects.toThrow(/安全访问|0x33|解锁/);
  });

  it('完整备份：35 上传 + 36 分块读回，和 ECU 内存一致', async () => {
    const { ecu, provider } = setup(256);
    await new FlashRunner(provider).backup(ctx(), region); // backup 内部会 session+unlock
    const data = await (async () => {
      await provider.enterProgrammingSession(ctx());
      await provider.unlock(ctx());
      return provider.readRegion(ctx(), region);
    })();
    expect(data).toEqual(ecu.memory);
    expect(imageChecksumOk(data)).toBe(true);
  });

  it('完整刷写：擦除→34 下载→36 分块写→37→31 校验，写入生效且校验和正确', async () => {
    const { ecu, provider } = setup(256);
    const orig = await new FlashRunner(provider).backup(ctx(), region);
    const file = await encodeBackup({ module: 'vw', variant: 'petrol', vin: null, calIds: [], region }, orig);

    ecu.memory.fill(0x00); // 模拟程序被刷坏
    const { data } = await decodeBackup(file);
    await new FlashRunner(provider).flash(ctx(), { region, image: data, backupFirst: true, minVoltage: 12.5, verifyAfterWrite: true });

    expect(ecu.memory.subarray(0, region.size - 4)).toEqual(orig.subarray(0, region.size - 4));
    expect(imageChecksumOk(ecu.memory)).toBe(true);
  });

  it('不同分块大小都能正确读写（边界）', async () => {
    for (const mb of [16, 100, 4096]) {
      const { ecu, provider } = setup(mb);
      const orig = ecu.memory.slice();
      await provider.enterProgrammingSession(ctx());
      await provider.unlock(ctx());
      const read = await provider.readRegion(ctx(), region);
      expect(read).toEqual(orig);
    }
  });
});
