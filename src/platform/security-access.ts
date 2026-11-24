import { bytesToHex, type SeedKeyAlgorithm } from './seedkey';

/**
 * ECU 安全访问（seed/key 握手）引擎。UDS（服务 0x27）与 KWP2000 时序相同。
 *
 *   27 <reqLevel>            -> 67 <reqLevel> <seed...>
 *   27 <sendLevel> <key...>  -> 67 <sendLevel>   (成功)
 *                            -> 7F 27 <NRC>       (失败)
 *
 * 一键解锁会用算法库里的算法逐个尝试。注意：真车上每次失败都会让 ECU 的
 * 错误计数 +1，超过上限会锁定一段时间，所以默认有尝试次数上限，避免把 ECU 锁死。
 */

/** 发送一条诊断请求，返回第一条响应消息（已去掉报头的原始字节） */
export interface SecurityAccessIO {
  request(hexCommand: string): Promise<Uint8Array>;
}

export interface UnlockOptions {
  /** 请求 seed 的子功能号（奇数，常见 0x01；编程会话常用 0x11 等） */
  requestLevel: number;
  /** 发送 key 的子功能号（= requestLevel + 1） */
  sendLevel: number;
  algorithms: SeedKeyAlgorithm[];
  /** 最多尝试几种算法（防止把 ECU 锁死）。演示模式可设很大 */
  maxAttempts: number;
  report?: (msg: string) => void;
  /** 遇到“需要等待”时，每次等待的毫秒数 */
  lockoutWaitMs?: number;
}

export interface UnlockResult {
  unlocked: boolean;
  algorithm?: SeedKeyAlgorithm;
  seedHex?: string;
  attempts: number;
  reason?: string;
}

const NRC: Record<number, string> = {
  0x12: '子功能不支持',
  0x22: '条件不满足（可能未进入编程会话）',
  0x24: '请求顺序错误',
  0x31: '请求超出范围',
  0x35: '密钥错误',
  0x36: '超过尝试次数，ECU 已锁定',
  0x37: '需要等待（上次失败后的延时未到）',
};

function level(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function securityAccess(io: SecurityAccessIO, opts: UnlockOptions): Promise<UnlockResult> {
  const report = opts.report ?? (() => {});
  const wait = opts.lockoutWaitMs ?? 11000;
  const maxWaits = 5; // 最多等待这么多次“延时未到”，防止卡死
  let attempts = 0;
  let waits = 0;

  for (let i = 0; i < opts.algorithms.length; ) {
    const algo = opts.algorithms[i];
    if (attempts >= opts.maxAttempts) {
      return { unlocked: false, attempts, reason: `已尝试 ${attempts} 种算法仍未解锁，为避免锁定 ECU 已停止` };
    }

    // 1) 请求 seed
    const seedResp = await io.request('27' + level(opts.requestLevel));
    const neg = negativeResponse(seedResp);
    if (neg === 0x37) {
      // 请求种子就被要求等待：锁定中，等一会再试同一个算法
      if (++waits > maxWaits) return { unlocked: false, attempts, reason: 'ECU 反复要求等待，已停止' };
      report(`ECU 要求等待，暂停 ${Math.round(wait / 1000)} 秒…`);
      await sleep(wait);
      continue;
    }
    if (neg !== null) return { unlocked: false, attempts, reason: `请求种子被拒绝：${NRC[neg] ?? '0x' + neg.toString(16)}` };
    if (seedResp[0] !== 0x67) return { unlocked: false, attempts, reason: `种子响应异常：${bytesToHex(seedResp)}` };
    const seed = seedResp.slice(2);
    if (seed.length > 0 && seed.every((b) => b === 0)) {
      return { unlocked: true, attempts, seedHex: bytesToHex(seed), reason: 'ECU 已处于解锁状态' };
    }

    // 2) 用这个算法算 key
    let key: Uint8Array;
    try {
      key = algo.compute(seed);
    } catch {
      i++; // 算法不适用于这个 seed 长度，换下一个（不消耗尝试次数）
      continue;
    }
    report(`尝试算法「${algo.label}」（seed ${bytesToHex(seed)}）…`);

    // 3) 发送 key
    const keyResp = await io.request('27' + level(opts.sendLevel) + bytesToHex(key));
    const success = keyResp[0] === 0x67 && keyResp[1] === opts.sendLevel;
    const knrc = success ? null : negativeResponse(keyResp);
    if (knrc === 0x37) {
      // 触发延时：等一会，重试同一个算法（这次没真正试成，不计入 attempts）
      if (++waits > maxWaits) return { unlocked: false, attempts, reason: 'ECU 反复要求等待，已停止' };
      report(`ECU 要求等待，暂停 ${Math.round(wait / 1000)} 秒…`);
      await sleep(wait);
      continue; // 不推进 i，重试当前算法
    }
    attempts++; // 得到了明确结果，算一次真正的尝试
    if (success) {
      report(`解锁成功，算法：${algo.label}`);
      return { unlocked: true, algorithm: algo, seedHex: bytesToHex(seed), attempts };
    }
    if (knrc === 0x36) return { unlocked: false, attempts, reason: NRC[0x36] };
    if (knrc !== null && knrc !== 0x35) {
      return { unlocked: false, attempts, reason: `发送密钥被拒绝：${NRC[knrc] ?? '0x' + knrc.toString(16)}` };
    }
    i++; // 0x35 密钥错误：换下一个算法
  }

  return { unlocked: false, attempts, reason: '算法库里没有能解锁这个 ECU 的算法，需要在台架上逆向它的 seed/key' };
}

function negativeResponse(resp: Uint8Array): number | null {
  return resp.length >= 3 && resp[0] === 0x7f && resp[1] === 0x27 ? resp[2] : null;
}
