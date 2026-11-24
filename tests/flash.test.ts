import { describe, expect, it } from 'vitest';
import { BackupFormatError, backupFileName, checkRestore, decodeBackup, encodeBackup } from '../src/platform/backup-file';
import { FlashRunner } from '../src/platform/flash-runner';
import { DemoFlashProvider, checksumOk } from '../src/modules/demo-flash';
import type { FlashContext } from '../src/platform/vehicle-module';

const region = { name: 'CAL', address: 0x80040000, size: 64 * 1024 };
const meta = { module: 'mini-r', variant: 'gen2', vin: 'WMWMF7C5XBTX98765', calIds: ['7557757000000000'], region };

function ctx(voltage = '12.8V', cancelAfter = Infinity): FlashContext & { messages: string[] } {
  let n = 0;
  const messages: string[] = [];
  return {
    elm: { send: async () => voltage } as never,
    obd: {} as never,
    report: (_p, m) => void messages.push(m),
    cancelled: () => ++n > cancelAfter,
    messages,
  };
}

describe('备份文件 .mrbk', () => {
  it('编码后能原样解码', async () => {
    const data = new Uint8Array(region.size).map((_, i) => i & 0xff);
    const file = await encodeBackup(meta, data);
    const back = await decodeBackup(file);
    expect(back.header.vin).toBe(meta.vin);
    expect(back.header.region).toEqual(region);
    expect(back.data).toEqual(data);
  });

  it('数据被改动一个字节就拒绝', async () => {
    const file = await encodeBackup(meta, new Uint8Array(region.size));
    file[file.length - 10] ^= 0xff;
    await expect(decodeBackup(file)).rejects.toThrow(/SHA-256/);
  });

  it('不是备份文件 / 被截断都拒绝', async () => {
    await expect(decodeBackup(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toBeInstanceOf(BackupFormatError);
    const file = await encodeBackup(meta, new Uint8Array(region.size));
    await expect(decodeBackup(file.slice(0, file.length - 1))).rejects.toThrow(/数据长度/);
  });

  it('文件名不含非法字符', () => {
    expect(backupFileName(meta, new Date('2026-11-24T10:20:30Z'))).toBe('mini-r_WMWMF7C5XBTX98765_CAL_20261124102030.mrbk');
  });
});

describe('恢复前检查（防刷错车）', () => {
  const header = { format: 1 as const, ...meta, sha256: 'x', createdAt: '' };
  it('同一辆车：放行', () => {
    expect(checkRestore(header, { module: 'mini-r', vin: meta.vin }, region)).toEqual({ blockers: [], warnings: [] });
  });
  it('另一辆车：禁止', () => {
    expect(checkRestore(header, { module: 'mini-r', vin: 'WMWZZZ00000000000' }, region).blockers[0]).toMatch(/另一辆车/);
  });
  it('不同车型或区域不一致：禁止', () => {
    expect(checkRestore(header, { module: 'vw-mqb', vin: meta.vin }, region).blockers.length).toBe(1);
    expect(checkRestore(header, { module: 'mini-r', vin: meta.vin }, { ...region, size: 1024 }).blockers[0]).toMatch(/ECU 型号/);
    expect(checkRestore(header, { module: 'mini-r', vin: meta.vin }, undefined).blockers[0]).toMatch(/没有/);
  });
  it('读不到 VIN：需要用户确认', () => {
    const r = checkRestore(header, { module: 'mini-r', vin: null }, region);
    expect(r.blockers).toEqual([]);
    expect(r.warnings[0]).toMatch(/VIN/);
  });
});

describe('一键备份 / 恢复（模拟 ECU）', () => {
  it('备份读出的是原厂程序，校验和正确', async () => {
    const ecu = new DemoFlashProvider(0);
    const data = await new FlashRunner(ecu).backup(ctx(), ecu.regions[0]);
    expect(data).toEqual(ecu.memory);
    expect(checksumOk(data)).toBe(true);
  });

  it('程序被改坏后，能从备份恢复并读回校验通过', async () => {
    const ecu = new DemoFlashProvider(0);
    const r = ecu.regions[0];
    const original = await new FlashRunner(ecu).backup(ctx(), r);
    const file = await encodeBackup(meta, original);

    ecu.memory.fill(0xff); // 模拟程序被刷坏
    const { data } = await decodeBackup(file);
    const res = await new FlashRunner(ecu).flash(ctx(), { region: r, image: data, backupFirst: true, minVoltage: 12.5, verifyAfterWrite: true });

    expect(ecu.memory).toEqual(original);
    expect(res.backup?.every((b) => b === 0xff)).toBe(true); // 恢复前的（坏）程序也被备份了
  });

  it('没解锁不能读', async () => {
    const ecu = new DemoFlashProvider(0);
    await expect(ecu.readRegion(ctx(), ecu.regions[0])).rejects.toThrow(/未解锁/);
  });

  it('电压低于 12.5V 时，一个字节都不写', async () => {
    const ecu = new DemoFlashProvider(0);
    const before = ecu.memory.slice();
    await expect(
      new FlashRunner(ecu).flash(ctx('11.9V'), { region: ecu.regions[0], image: new Uint8Array(region.size), backupFirst: true, minVoltage: 12.5 }),
    ).rejects.toThrow(/电压过低/);
    expect(ecu.memory).toEqual(before);
  });

  it('文件大小不对时拒绝写入', async () => {
    const ecu = new DemoFlashProvider(0);
    await expect(
      new FlashRunner(ecu).flash(ctx(), { region: ecu.regions[0], image: new Uint8Array(100), backupFirst: false, minVoltage: 12.5 }),
    ).rejects.toThrow(/大小/);
  });

  it('写入中途取消会明确报错（提示重新恢复）', async () => {
    const ecu = new DemoFlashProvider(0);
    const r = ecu.regions[0];
    await expect(
      new FlashRunner(ecu).flash(ctx('12.8V', 40), { region: r, image: new Uint8Array(r.size), backupFirst: true, minVoltage: 12.5 }),
    ).rejects.toThrow(/中断|取消/);
  });
});
