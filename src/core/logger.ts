import { PIDS, type PidDef } from './obd';

/**
 * 数据记录（datalogging）。只读采集,零风险。
 *
 * 支持三种跑法:
 *  - 手动:点开始就记,点停止结束。
 *  - 自动触发:满足“开始条件”才记(如 节气门>90%),到时长或条件消失后自动停(“自行按要求跑 log”)。
 * 逐 tick 采集所选通道,带时间戳,可导出 CSV。
 */

export type CompareOp = '>' | '<' | '>=' | '<=';

export interface LogTrigger {
  /** 触发通道的 PID */
  startPid: number;
  startOp: CompareOp;
  startValue: number;
  /** 开始后最多记录多少秒(到点自动停) */
  stopAfterS?: number;
  /** 开始条件不再成立时自动停(例如松油门) */
  stopWhenConditionClears?: boolean;
}

export interface LogProfile {
  /** 要记录的通道（PID 号） */
  channels: number[];
  intervalMs: number;
  trigger?: LogTrigger;
}

export interface LogRow {
  t: number; // 相对开始的毫秒
  values: Record<number, number | null>;
}

export type LoggerState = 'idle' | 'armed' | 'recording' | 'stopped';

function compare(v: number, op: CompareOp, ref: number): boolean {
  switch (op) {
    case '>': return v > ref;
    case '<': return v < ref;
    case '>=': return v >= ref;
    case '<=': return v <= ref;
  }
}

export function pidName(pid: number): string {
  return PIDS.find((p) => p.pid === pid)?.name ?? `PID 0x${pid.toString(16)}`;
}

export interface LoggerOptions {
  read: (pid: number) => Promise<number | null>;
  profile: LogProfile;
  now?: () => number;
  onRow?: (row: LogRow, state: LoggerState) => void;
  onState?: (state: LoggerState) => void;
}

export class DataLogger {
  rows: LogRow[] = [];
  state: LoggerState = 'idle';
  private startedAt: number | null = null;
  private readonly now: () => number;
  private readonly readSet: number[];
  private running = false;

  constructor(private readonly opts: LoggerOptions) {
    this.now = opts.now ?? (() => Date.now());
    const trig = opts.profile.trigger;
    const set = new Set(opts.profile.channels);
    if (trig) set.add(trig.startPid);
    this.readSet = [...set];
  }

  private setState(s: LoggerState): void {
    this.state = s;
    this.opts.onState?.(s);
  }

  /** 进入采集/待触发状态 */
  begin(): void {
    this.rows = [];
    this.startedAt = null;
    if (this.opts.profile.trigger) this.setState('armed');
    else {
      this.startedAt = this.now();
      this.setState('recording');
    }
  }

  /** 执行一次采集；返回当前状态。供自动循环或测试逐步调用 */
  async tick(): Promise<LoggerState> {
    if (this.state === 'stopped' || this.state === 'idle') return this.state;
    const values: Record<number, number | null> = {};
    for (const pid of this.readSet) values[pid] = await this.read(pid);
    const trig = this.opts.profile.trigger;

    if (this.state === 'armed' && trig) {
      const v = values[trig.startPid];
      if (v !== null && compare(v, trig.startOp, trig.startValue)) {
        this.startedAt = this.now();
        this.setState('recording');
      } else {
        return this.state; // 还没触发,不记
      }
    }

    if (this.state === 'recording') {
      const t = this.now() - (this.startedAt ?? this.now());
      const row: LogRow = { t, values: pick(values, this.opts.profile.channels) };
      this.rows.push(row);
      this.opts.onRow?.(row, this.state);
      if (trig) {
        if (trig.stopAfterS !== undefined && t >= trig.stopAfterS * 1000) this.stop();
        else if (trig.stopWhenConditionClears) {
          const v = values[trig.startPid];
          if (v === null || !compare(v, trig.startOp, trig.startValue)) this.stop();
        }
      }
    }
    return this.state;
  }

  private async read(pid: number): Promise<number | null> {
    try {
      return await this.opts.read(pid);
    } catch {
      return null;
    }
  }

  /** 自动循环,直到停止 */
  async run(sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.begin();
    try {
      while (this.state === 'armed' || this.state === 'recording') {
        await this.tick();
        if (this.state === 'armed' || this.state === 'recording') await sleep(this.opts.profile.intervalMs);
      }
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.state !== 'stopped') this.setState('stopped');
    this.running = false;
  }

  toCsv(): string {
    const chans = this.opts.profile.channels;
    const header = ['time_ms', ...chans.map((c) => pidName(c) + unitOf(c))];
    const lines = [header.join(',')];
    for (const r of this.rows) {
      lines.push([r.t, ...chans.map((c) => fmt(r.values[c], c))].join(','));
    }
    return lines.join('\n');
  }
}

function pick(values: Record<number, number | null>, channels: number[]): Record<number, number | null> {
  const out: Record<number, number | null> = {};
  for (const c of channels) out[c] = values[c] ?? null;
  return out;
}
function def(pid: number): PidDef | undefined {
  return PIDS.find((p) => p.pid === pid);
}
function unitOf(pid: number): string {
  const u = def(pid)?.unit;
  return u ? `(${u})` : '';
}
function fmt(v: number | null, pid: number): string {
  if (v === null || v === undefined) return '';
  return v.toFixed(def(pid)?.digits ?? 0);
}
