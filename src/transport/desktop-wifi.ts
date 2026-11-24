import { desktop } from './desktop-api';
import { TransportEvents, type Transport } from './transport';

/**
 * 桌面(Electron)下的 WiFi 版 ELM327：TCP 走主进程的 net 模块。
 * 数据按连接 id 分发到对应实例，所以 IPC 监听只注册一次。
 */
const routes = new Map<number, { data: (s: string) => void; close: () => void }>();
let wired = false;

function ensureWired(): void {
  if (wired) return;
  const d = desktop();
  if (!d) return;
  wired = true;
  d.onTcpData((m) => routes.get(m.id)?.data(m.data));
  d.onTcpClose((m) => routes.get(m.id)?.close());
}

export class DesktopWifiTransport implements Transport {
  readonly label: string;
  private readonly events = new TransportEvents();
  private id: number | null = null;

  constructor(
    private readonly host = '192.168.0.10',
    private readonly port = 35000,
  ) {
    this.label = `WiFi ${host}:${port}`;
  }

  async open(): Promise<void> {
    const d = desktop();
    if (!d) throw new Error('桌面接口不可用');
    ensureWired();
    this.id = await d.tcpConnect(this.host, this.port);
    routes.set(this.id, {
      data: (s) => this.events.emitData(s),
      close: () => {
        if (this.id !== null) routes.delete(this.id);
        this.id = null;
        this.events.emitClose();
      },
    });
  }

  async close(): Promise<void> {
    const d = desktop();
    if (this.id !== null && d) {
      routes.delete(this.id);
      d.tcpClose(this.id);
    }
    this.id = null;
  }

  async write(text: string): Promise<void> {
    const d = desktop();
    if (this.id === null || !d) throw new Error('WiFi 未连接');
    d.tcpWrite(this.id, text);
  }

  onData(cb: (chunk: string) => void): void {
    this.events.onData(cb);
  }

  onClose(cb: () => void): void {
    this.events.onClose(cb);
  }
}
