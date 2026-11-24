import { DataEncoding, TcpSocket } from 'capacitor-tcp-socket';
import { TransportEvents, type Transport } from './transport';

/**
 * WiFi 版 ELM327：手机先连上适配器的热点（常见名称 “WiFi_OBDII”），
 * 默认地址 192.168.0.10:35000。安卓和 iPhone 都可用。
 */
export class WifiTransport implements Transport {
  readonly label: string;
  private readonly events = new TransportEvents();
  private client: number | null = null;

  constructor(
    private readonly host = '192.168.0.10',
    private readonly port = 35000,
  ) {
    this.label = `WiFi ${host}:${port}`;
  }

  async open(): Promise<void> {
    const { client } = await TcpSocket.connect({ ipAddress: this.host, port: this.port, timeout: 10 });
    this.client = client;
    void this.readLoop(client);
  }

  private async readLoop(client: number): Promise<void> {
    const decoder = new TextDecoder();
    while (this.client === client) {
      try {
        const r = await TcpSocket.read({ client, expectLen: 1024, timeout: 0, encoding: DataEncoding.BASE64 });
        const bytes = Uint8Array.from(atob(r.result), (c) => c.charCodeAt(0));
        this.events.emitData(decoder.decode(bytes, { stream: true }));
      } catch {
        // EOF / CLOSED：连接已断开
        if (this.client === client) {
          this.client = null;
          this.events.emitClose();
        }
        return;
      }
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c !== null) await TcpSocket.disconnect({ client: c });
  }

  async write(text: string): Promise<void> {
    if (this.client === null) throw new Error('WiFi 未连接');
    await TcpSocket.send({ client: this.client, data: text, encoding: DataEncoding.UTF8 });
  }

  onData(cb: (chunk: string) => void): void {
    this.events.onData(cb);
  }

  onClose(cb: () => void): void {
    this.events.onClose(cb);
  }
}
