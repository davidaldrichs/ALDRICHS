import { BleClient, dataViewToText, numberToUUID, textToDataView, type BleService } from '@capacitor-community/bluetooth-le';
import { TransportEvents, type Transport } from './transport';

/**
 * 常见 BLE 版 ELM327 适配器使用的服务 UUID。
 * iOS 只能用 BLE 版适配器（经典蓝牙 SPP 版在 iPhone 上无法连接）。
 */
const KNOWN_SERVICES = [
  numberToUUID(0xfff0), // 多数国产 BLE OBD（FFF1 通知 / FFF2 写）
  numberToUUID(0xffe0), // HM-10 类模块（FFE1 读写）
  numberToUUID(0x18f0), // 部分 Veepeak / OBDLink（2AF0 通知 / 2AF1 写）
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Vgate iCar Pro BLE
];

/** 单次 BLE 写入最多 20 字节（默认 MTU） */
const CHUNK = 20;

interface Pipe {
  service: string;
  notify: string;
  write: string;
  withoutResponse: boolean;
}

export function pickPipe(services: BleService[]): Pipe | null {
  const ordered = [...services].sort((a, b) => rank(a.uuid) - rank(b.uuid));
  for (const s of ordered) {
    const notify = s.characteristics.find((c) => c.properties.notify || c.properties.indicate);
    const write =
      s.characteristics.find((c) => c.properties.write) ??
      s.characteristics.find((c) => c.properties.writeWithoutResponse);
    if (notify && write) {
      return { service: s.uuid, notify: notify.uuid, write: write.uuid, withoutResponse: !write.properties.write };
    }
  }
  return null;
}

function rank(uuid: string): number {
  const i = KNOWN_SERVICES.indexOf(uuid.toLowerCase());
  return i < 0 ? 99 : i;
}

export class BleTransport implements Transport {
  label = '蓝牙 BLE';
  private readonly events = new TransportEvents();
  private deviceId: string | null = null;
  private pipe: Pipe | null = null;

  async open(): Promise<void> {
    await BleClient.initialize({ androidNeverForLocation: true });
    const device = await BleClient.requestDevice({ optionalServices: KNOWN_SERVICES });
    this.label = `蓝牙 ${device.name ?? device.deviceId}`;
    await BleClient.connect(device.deviceId, () => {
      this.deviceId = null;
      this.events.emitClose();
    });
    this.deviceId = device.deviceId;
    const pipe = pickPipe(await BleClient.getServices(device.deviceId));
    if (!pipe) {
      await BleClient.disconnect(device.deviceId);
      throw new Error('这个蓝牙设备不像 ELM327 适配器（找不到可读写的串口服务）');
    }
    this.pipe = pipe;
    await BleClient.startNotifications(device.deviceId, pipe.service, pipe.notify, (v) =>
      this.events.emitData(dataViewToText(v)),
    );
  }

  async close(): Promise<void> {
    if (this.deviceId) await BleClient.disconnect(this.deviceId);
    this.deviceId = null;
  }

  async write(text: string): Promise<void> {
    if (!this.deviceId || !this.pipe) throw new Error('蓝牙未连接');
    const { service, write, withoutResponse } = this.pipe;
    for (let i = 0; i < text.length; i += CHUNK) {
      const dv = textToDataView(text.slice(i, i + CHUNK));
      if (withoutResponse) await BleClient.writeWithoutResponse(this.deviceId, service, write, dv);
      else await BleClient.write(this.deviceId, service, write, dv);
    }
  }

  onData(cb: (chunk: string) => void): void {
    this.events.onData(cb);
  }

  onClose(cb: () => void): void {
    this.events.onClose(cb);
  }
}
