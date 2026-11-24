/**
 * 与 OBD 适配器之间的字节/文本通道。
 * ELM327 是基于 ASCII 的协议，所以这里统一用字符串传输。
 */
export interface Transport {
  /** 显示给用户看的名字，例如 “蓝牙 Vgate iCar Pro” */
  readonly label: string;
  open(): Promise<void>;
  close(): Promise<void>;
  write(text: string): Promise<void>;
  /** 注册数据回调；每次收到一段数据（不保证是完整一行）时调用 */
  onData(cb: (chunk: string) => void): void;
  /** 连接被对方断开时调用 */
  onClose(cb: () => void): void;
}

/** 给各个 Transport 实现复用的回调管理 */
export class TransportEvents {
  private dataCbs: Array<(chunk: string) => void> = [];
  private closeCbs: Array<() => void> = [];

  onData(cb: (chunk: string) => void): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  emitData(chunk: string): void {
    for (const cb of this.dataCbs) cb(chunk);
  }

  emitClose(): void {
    for (const cb of this.closeCbs) cb();
  }
}
