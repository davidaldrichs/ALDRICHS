import { TransportEvents, type Transport } from './transport';
import type { Generation } from '../core/mini';

/**
 * 模拟的 ELM327 + MINI ECU，用于“演示模式”和自动化测试。
 * 一代模拟 K-Line（ISO 14230）的响应格式，二代模拟 CAN（ISO 15765）的多帧格式。
 */
export class SimulatorTransport implements Transport {
  readonly label: string;
  private readonly events = new TransportEvents();
  private dtcs: string[];
  private t = 0;
  private pending = '';

  constructor(
    private readonly generation: Generation,
    private readonly latencyMs = 15,
  ) {
    this.label = `演示模式（模拟${generation === 1 ? '一代 R53' : '二代 R56'}）`;
    this.dtcs = generation === 1 ? ['0171', '0301'] : ['0016', '0299', '0420'];
  }

  async open(): Promise<void> {}

  async close(): Promise<void> {
    this.events.emitClose();
  }

  onData(cb: (chunk: string) => void): void {
    this.events.onData(cb);
  }

  onClose(cb: () => void): void {
    this.events.onClose(cb);
  }

  async write(text: string): Promise<void> {
    this.pending += text;
    let idx: number;
    while ((idx = this.pending.indexOf('\r')) >= 0) {
      const cmd = this.pending.slice(0, idx).trim().toUpperCase().replace(/\s+/g, '');
      this.pending = this.pending.slice(idx + 1);
      const reply = this.respond(cmd);
      setTimeout(() => this.events.emitData(reply + '\r\r>'), this.latencyMs);
    }
  }

  private get isCan(): boolean {
    return this.generation === 2;
  }

  private respond(cmd: string): string {
    if (cmd === 'ATZ') return '\r\rELM327 v1.5';
    if (cmd === 'ATRV') return '12.6V';
    if (cmd === 'ATDP') return this.isCan ? 'AUTO, ISO 15765-4 (CAN 11/500)' : 'AUTO, ISO 14230-4 (KWP FAST)';
    if (cmd === 'ATDPN') return this.isCan ? 'A6' : 'A5';
    if (cmd.startsWith('AT')) return 'OK';

    this.t += 1;
    const wave = (min: number, max: number, period = 20) =>
      Math.round(min + ((max - min) * (1 + Math.sin((this.t / period) * 2 * Math.PI))) / 2);

    switch (cmd) {
      case '0100':
        return this.isCan ? 'SEARCHING...\r41 00 BE 3F A8 13' : 'BUS INIT: ...OK\r41 00 BE 3E B8 11';
      case '0120':
        return '41 20 80 02 20 01'; // 21、2F、33、40
      case '0140':
        return this.isCan ? '41 40 44 D0 00 10' : '41 40 40 00 00 00';
      case '0101':
        return `41 01 ${hex(0x80 | this.dtcs.length)} 07 65 00`;
      case '010C': {
        const rpm = wave(750, 3200) * 4;
        return `41 0C ${hex(rpm >> 8)} ${hex(rpm & 0xff)}`;
      }
      case '010D':
        return `41 0D ${hex(wave(0, 90))}`;
      case '0105':
        return `41 05 ${hex(90 + 40)}`;
      case '010F':
        return `41 0F ${hex(32 + 40)}`;
      case '0104':
        return `41 04 ${hex(wave(40, 200))}`;
      case '0111':
        return `41 11 ${hex(wave(30, 180))}`;
      case '010B':
        return `41 0B ${hex(wave(30, this.isCan ? 210 : 170))}`;
      case '0110': {
        const maf = wave(300, 4500);
        return `41 10 ${hex(maf >> 8)} ${hex(maf & 0xff)}`;
      }
      case '010E':
        return `41 0E ${hex(wave(140, 170))}`;
      case '0106':
        return `41 06 ${hex(wave(124, 132))}`;
      case '0107':
        return '41 07 85';
      case '0133':
        return '41 33 65';
      case '0142':
        return this.isCan ? '41 42 37 B0' : 'NO DATA';
      case '012F':
        return '41 2F 99';
      case '0146':
        return this.isCan ? '41 46 3A' : 'NO DATA';
      case '015C':
        return this.isCan ? `41 5C ${hex(98 + 40)}` : 'NO DATA';
      case '03':
        return this.dtcReply(0x43);
      case '07':
        return this.isCan ? '47 00' : 'NO DATA';
      case '0A':
        return 'NO DATA';
      case '04':
        this.dtcs = [];
        return '44';
      case '0902':
        return this.vinReply();
      case '0904':
        return this.isCan
          ? '013\r0: 49 04 01 37 35 35\r1: 37 37 35 37 30 30 30\r2: 30 30 30 30 30 30 30'
          : '49 04 01 31 34 33 39\r49 04 02 32 31 30 39\r49 04 03 30 30 30 30\r49 04 04 00 00 00 00';
      case '0906':
        return this.isCan ? '49 06 01 7A 3C 11 E0' : '49 06 01 4B 2D 90 0C';
      case '090A':
        return this.isCan
          ? '017\r0: 49 0A 01 45 43 4D\r1: 00 2D 45 6E 67 69 6E\r2: 65 43 6F 6E 74 72 6F\r3: 6C 00 00 00 00 00 00'
          : 'NO DATA';
      default:
        return this.isCan ? 'NO DATA' : '?';
    }
  }

  private dtcReply(head: number): string {
    const bytes = this.dtcs.map((d) => `${d.slice(0, 2)} ${d.slice(2)}`);
    if (this.isCan) return `${hex(head)} ${hex(this.dtcs.length)} ${bytes.join(' ')}`.trim();
    // K-Line：每帧 3 个故障码，用 00 00 补齐
    if (bytes.length === 0) return `${hex(head)} 00 00 00 00 00 00`;
    const frames: string[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      const chunk = bytes.slice(i, i + 3);
      while (chunk.length < 3) chunk.push('00 00');
      frames.push(`${hex(head)} ${chunk.join(' ')}`);
    }
    return frames.join('\r');
  }

  private vinReply(): string {
    const vin = this.generation === 1 ? 'WMWRE33456TJ12345' : 'WMWMF7C5XBTX98765';
    const b = [...vin].map((c) => hex(c.charCodeAt(0)));
    if (this.isCan) {
      return `014\r0: 49 02 01 ${b.slice(0, 3).join(' ')}\r1: ${b.slice(3, 10).join(' ')}\r2: ${b.slice(10, 17).join(' ')}`;
    }
    const frames = [`49 02 01 00 00 00 ${b[0]}`];
    for (let i = 1, n = 2; i < 17; i += 4, n++) frames.push(`49 02 0${n} ${b.slice(i, i + 4).join(' ')}`);
    return frames.join('\r');
  }
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}
