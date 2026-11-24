import { describe, expect, it } from 'vitest';
import { DataLogger, type LogProfile } from '../src/core/logger';

// 用受控时钟 + 脚本化读数,确定性测试
function scriptedLogger(profile: LogProfile, reads: Record<number, number[]>) {
  let i = 0;
  let clock = 0;
  const log = new DataLogger({
    profile,
    now: () => clock,
    read: async (pid) => reads[pid]?.[Math.min(i, (reads[pid]?.length ?? 1) - 1)] ?? null,
  });
  const step = (dt = profile.intervalMs) => {
    clock += dt;
    i++;
  };
  return { log, step };
}

describe('数据记录', () => {
  it('手动记录:每 tick 记一行', async () => {
    const { log, step } = scriptedLogger({ channels: [0x0c, 0x0d], intervalMs: 100 }, { 0x0c: [800, 1200, 1600], 0x0d: [0, 10, 20] });
    log.begin();
    for (let k = 0; k < 3; k++) { await log.tick(); step(); }
    expect(log.rows).toHaveLength(3);
    expect(log.rows[0].values[0x0c]).toBe(800);
    expect(log.rows[2].values[0x0d]).toBe(20);
  });

  it('自动触发:条件满足才开始，到时长自动停', async () => {
    // 节气门(0x11) 爬升，>80 触发，记 0.2s 后停
    const reads = { 0x11: [10, 50, 90, 95, 95, 95, 95], 0x0c: [800, 900, 3000, 3200, 3300, 3300, 3300] };
    const { log, step } = scriptedLogger({ channels: [0x0c], intervalMs: 100, trigger: { startPid: 0x11, startOp: '>', startValue: 80, stopAfterS: 0.2 } }, reads);
    log.begin();
    expect(log.state).toBe('armed');
    await log.tick(); step(); // throttle 10 → 不记
    await log.tick(); step(); // 50 → 不记
    expect(log.rows).toHaveLength(0);
    expect(log.state).toBe('armed');
    await log.tick(); step(); // 90 → 触发，记第一行 (t=0)
    expect(log.state).toBe('recording');
    await log.tick(); step(); // t=100
    await log.tick(); step(); // t=200 → >=0.2s 停
    expect(log.state).toBe('stopped');
    expect(log.rows.length).toBeGreaterThanOrEqual(2);
    expect(log.rows[0].t).toBe(0);
  });

  it('松开条件自动停', async () => {
    const reads = { 0x11: [90, 90, 20], 0x0c: [3000, 3100, 900] };
    const { log, step } = scriptedLogger({ channels: [0x0c], intervalMs: 100, trigger: { startPid: 0x11, startOp: '>', startValue: 80, stopWhenConditionClears: true } }, reads);
    log.begin();
    await log.tick(); step(); // 90 触发+记
    await log.tick(); step(); // 90 记
    await log.tick(); step(); // 20 → 条件消失,停
    expect(log.state).toBe('stopped');
  });

  it('CSV 含表头和单位', async () => {
    const { log, step } = scriptedLogger({ channels: [0x0c, 0x05], intervalMs: 100 }, { 0x0c: [800], 0x05: [90] });
    log.begin(); await log.tick(); step();
    const csv = log.toCsv();
    expect(csv.split('\n')[0]).toContain('time_ms');
    expect(csv).toContain('rpm');
    expect(csv).toContain('°C');
  });

  it('run() 自动跑到停', async () => {
    const reads = { 0x11: [90, 90, 90], 0x0c: [3000, 3100, 3200] };
    const { log } = scriptedLogger({ channels: [0x0c], intervalMs: 1, trigger: { startPid: 0x11, startOp: '>', startValue: 80, stopAfterS: 0 } }, reads);
    await log.run(async () => {}); // stopAfterS=0 → 记一行即停
    expect(log.state).toBe('stopped');
    expect(log.rows.length).toBeGreaterThanOrEqual(1);
  });
});
