import { TransportEvents, type Transport } from './transport';

/**
 * 桌面(Electron)下的串口 / 经典蓝牙(COM 口)版 ELM327，用 Chromium 的 Web Serial。
 * 端口选择弹窗由主进程 + 界面处理（见 main.ts 的 serial:list）。
 */
interface SerialLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

export class DesktopSerialTransport implements Transport {
  label = '串口';
  private readonly events = new TransportEvents();
  private port: SerialLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closing = false;

  constructor(private readonly baudRate = 38400) {}

  async open(): Promise<void> {
    const serial = (navigator as unknown as { serial?: { requestPort(): Promise<SerialLike> } }).serial;
    if (!serial) throw new Error('当前环境不支持串口（Web Serial）');
    const port = await serial.requestPort(); // 触发端口选择弹窗
    await port.open({ baudRate: this.baudRate });
    this.port = port;
    const info = port.getInfo?.();
    this.label =
      info?.usbVendorId != null
        ? `串口 USB ${info.usbVendorId.toString(16)}:${(info.usbProductId ?? 0).toString(16)}`
        : '串口 / 蓝牙 COM';
    if (port.writable) this.writer = port.writable.getWriter();
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    if (!this.port?.readable) return;
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.events.emitData(decoder.decode(value, { stream: true }));
      }
    } catch {
      // 读循环被取消或连接断开
    } finally {
      if (!this.closing) this.events.emitClose();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = null;
  }

  async write(text: string): Promise<void> {
    if (!this.writer) throw new Error('串口未连接');
    await this.writer.write(new TextEncoder().encode(text));
  }

  onData(cb: (chunk: string) => void): void {
    this.events.onData(cb);
  }

  onClose(cb: () => void): void {
    this.events.onClose(cb);
  }
}
