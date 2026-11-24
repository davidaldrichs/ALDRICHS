import { describe, expect, it } from 'vitest';
import { Elm327, cleanResponse, parseHexMessages } from '../src/core/elm327';
import { ObdService, PIDS, decodeDtc, parseDtcMessages, parseSupportedBitmap, parseVin } from '../src/core/obd';
import { guessFromVin } from '../src/core/mini';
import { describeDtc } from '../src/core/dtc-db';
import { pickPipe } from '../src/transport/ble';
import { SimulatorTransport } from '../src/transport/simulator';

describe('ELM327 响应解析', () => {
  it('去掉回显和 SEARCHING', () => {
    expect(cleanResponse('0100\rSEARCHING...\r41 00 BE 3F A8 13\r\r', '0100')).toBe('41 00 BE 3F A8 13');
  });

  it('合并 CAN 多帧消息并按长度截断', () => {
    const msgs = parseHexMessages('014\n0: 49 02 01 57 4D 57\n1: 4D 46 37 43 35 58 42\n2: 54 58 39 38 37 36 35');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].length).toBe(0x14);
  });

  it('每行一条消息（K-Line / 多 ECU）', () => {
    expect(parseHexMessages('41 0C 1A F8\n41 0C 1A F0')).toHaveLength(2);
  });

  it('不把文字当成十六进制', () => {
    expect(parseHexMessages('NO DATA')).toHaveLength(0);
  });
});

describe('OBD 解码', () => {
  it('故障码编码', () => {
    expect(decodeDtc(0x01, 0x71)).toBe('P0171');
    expect(decodeDtc(0x43, 0x00)).toBe('C0300');
    expect(decodeDtc(0xc1, 0x00)).toBe('U0100');
    expect(decodeDtc(0x9a, 0x1b)).toBe('B1A1B');
  });

  it('CAN 故障码跳过数量字节', () => {
    const msgs = parseHexMessages('43 02 01 71 03 01');
    expect(parseDtcMessages(msgs, 0x03, true)).toEqual(['P0171', 'P0301']);
  });

  it('K-Line 故障码忽略 00 00 补位，合并多帧', () => {
    const msgs = parseHexMessages('43 01 71 03 01 04 20\n43 00 16 00 00 00 00');
    expect(parseDtcMessages(msgs, 0x03, false)).toEqual(['P0171', 'P0301', 'P0420', 'P0016']);
  });

  it('支持 PID 位图', () => {
    const list = parseSupportedBitmap(0, [0xbe, 0x1f, 0xa8, 0x13]);
    expect(list).toContain(0x01);
    expect(list).toContain(0x0c);
    expect(list).toContain(0x20);
    expect(list).not.toContain(0x02);
  });

  it('K-Line 多帧 VIN', () => {
    const msgs = parseHexMessages(
      '49 02 01 00 00 00 57\n49 02 02 4D 57 52 45\n49 02 03 33 33 34 35\n49 02 04 36 54 4A 31\n49 02 05 32 33 34 35',
    );
    expect(parseVin(msgs)).toBe('WMWRE33456TJ12345');
  });
});

describe('MINI 车型识别', () => {
  it('按年款判断代数', () => {
    expect(guessFromVin('WMWRE33456TJ12345').generation).toBe(1);
    expect(guessFromVin('WMWMF7C5XBTX98765').generation).toBe(2);
    expect(guessFromVin('WMWMF7C5X7TX98765').generation).toBeNull(); // 2007 重叠年款
    expect(guessFromVin('WMWRE33456TJ1234').valid).toBe(false);
    expect(guessFromVin('1HGCM82633A004352').isMini).toBe(false);
  });

  it('故障码说明', () => {
    expect(describeDtc('P0016')).toMatch(/正时/);
    expect(describeDtc('P1234')).toMatch(/厂家/);
    expect(describeDtc('U0999')).toMatch(/网络/);
  });
});

describe('BLE 服务选择', () => {
  const props = (p: Partial<Record<string, boolean>>) =>
    ({ broadcast: false, read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false, authenticatedSignedWrites: false, ...p });
  it('优先已知的 FFF0 服务，选出通知和写特征', () => {
    const pipe = pickPipe([
      { uuid: '0000180a-0000-1000-8000-00805f9b34fb', characteristics: [{ uuid: 'a', properties: props({ notify: true, write: true }), descriptors: [] }] },
      {
        uuid: '0000fff0-0000-1000-8000-00805f9b34fb',
        characteristics: [
          { uuid: 'fff1', properties: props({ notify: true }), descriptors: [] },
          { uuid: 'fff2', properties: props({ writeWithoutResponse: true }), descriptors: [] },
        ],
      },
    ]);
    expect(pipe).toEqual({ service: '0000fff0-0000-1000-8000-00805f9b34fb', notify: 'fff1', write: 'fff2', withoutResponse: true });
  });
});

for (const gen of [1, 2] as const) {
  describe(`端到端：模拟${gen === 1 ? '一代 K-Line' : '二代 CAN'}`, () => {
    const setup = async () => {
      const elm = new Elm327(new SimulatorTransport(gen, 1));
      const info = await elm.initialize();
      return { elm, info, obd: new ObdService(elm) };
    };

    it('识别协议', async () => {
      const { info } = await setup();
      expect(info.isCan).toBe(gen === 2);
      expect(info.version).toContain('ELM327');
    });

    it('读取车辆信息', async () => {
      const { obd } = await setup();
      const v = await obd.readVehicleInfo();
      expect(v.vin).toBe(gen === 1 ? 'WMWRE33456TJ12345' : 'WMWMF7C5XBTX98765');
      expect(v.calIds[0]).toBe(gen === 1 ? '143921090000' : '7557757000000000');
      expect(v.cvns).toHaveLength(1);
      expect(v.mil?.milOn).toBe(true);
      expect(v.supportedPids).toContain(0x0c);
      if (gen === 2) expect(v.ecuName).toBe('ECM-EngineControl');
    });

    it('读取、清除故障码', async () => {
      const { obd } = await setup();
      const before = await obd.readDtcs('stored');
      expect(before).toEqual(gen === 1 ? ['P0171', 'P0301'] : ['P0016', 'P0299', 'P0420']);
      expect(await obd.readDtcs('permanent')).toEqual([]);
      expect(await obd.clearDtcs()).toBe(true);
      expect(await obd.readDtcs('stored')).toEqual([]);
    });

    it('读取实时数据', async () => {
      const { obd } = await setup();
      const rpm = await obd.readPid(PIDS.find((p) => p.pid === 0x0c)!);
      expect(rpm).toBeGreaterThanOrEqual(750);
      expect(rpm).toBeLessThanOrEqual(3200);
      expect(await obd.readPid(PIDS.find((p) => p.pid === 0x05)!)).toBe(90);
    });
  });
}

import { MODULES, availableModules, getModule, reservedModules } from '../src/modules/registry';
import { FlashRunner } from '../src/platform/flash-runner';

describe('车型模块框架', () => {
  it('MINI R 是已可用模块，有一代/二代两个变体', () => {
    const m = getModule('mini-r')!;
    expect(m.status).toBe('available');
    expect(m.variants.map((v) => v.id)).toEqual(['gen1', 'gen2']);
    expect(m.variants[0].isCan).toBe(false); // 一代 K-Line
    expect(m.variants[1].isCan).toBe(true); // 二代 CAN
    expect(m.variants[1].subModels.map((s) => s.code)).toContain('R56');
  });

  it('MINI 刷写窗口已预留但未开放', () => {
    expect(getModule('mini-r')!.flash).toBeUndefined();
  });

  it('其它品牌作为预留窗口占位', () => {
    expect(reservedModules().length).toBeGreaterThan(0);
    expect(availableModules().map((m) => m.id)).toEqual(['mini-r', 'mercedes']);
    expect(MODULES.find((m) => m.id === 'vw-mqb')!.status).toBe('reserved');
  });

  it('MINI VIN 分析走模块', () => {
    const m = getModule('mini-r')!;
    expect(m.analyzeVin!('WMWMF7C5XBTX98765').variantId).toBe('gen2');
    expect(m.analyzeVin!('1HGCM82633A004352').belongsToModule).toBe(false);
  });

  it('MINI 专属故障码 + 回退到通用库', () => {
    const m = getModule('mini-r')!;
    expect(m.describeDtc!('P1776')).toMatch(/旁通阀/);
    expect(m.describeDtc!('P0301')).toMatch(/失火/); // 回退到通用
  });

  it('通用刷写流程按固定顺序调度 provider', async () => {
    const calls: string[] = [];
    const ctx = {
      elm: { send: async () => '13.8V', info: null } as never,
      obd: {} as never,
      report: () => {},
      cancelled: () => false,
    };
    const region = { name: 'cal', address: 0, size: 4 };
    const provider = {
      regions: [region],
      enterProgrammingSession: async () => void calls.push('session'),
      unlock: async () => void calls.push('unlock'),
      readRegion: async () => (calls.push('read'), new Uint8Array(4)),
      validateImage: async () => void calls.push('validate'),
      writeRegion: async () => void calls.push('write'),
      finalizeChecksum: async () => void calls.push('checksum'),
      reset: async () => void calls.push('reset'),
    };
    const res = await new FlashRunner(provider).flash(ctx, {
      region,
      image: new Uint8Array(4),
      backupFirst: true,
      minVoltage: 12.5,
    });
    expect(calls).toEqual(['validate', 'session', 'unlock', 'read', 'write', 'checksum', 'reset']);
    expect(res.backup).toBeInstanceOf(Uint8Array);
  });

  it('电压过低拒绝刷写', async () => {
    const ctx = { elm: { send: async () => '11.0V' } as never, obd: {} as never, report: () => {}, cancelled: () => false };
    const region = { name: 'cal', address: 0, size: 4 };
    const noop = async () => {};
    const provider = {
      regions: [region],
      enterProgrammingSession: noop, unlock: noop,
      readRegion: async () => new Uint8Array(4),
      validateImage: noop, writeRegion: noop, finalizeChecksum: noop, reset: noop,
    };
    await expect(
      new FlashRunner(provider).flash(ctx, { region, image: new Uint8Array(4), backupFirst: false, minVoltage: 12.5 }),
    ).rejects.toThrow(/电压过低/);
  });
});
