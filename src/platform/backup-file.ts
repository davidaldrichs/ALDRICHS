/**
 * 原厂程序备份文件格式（.mrbk）。
 *
 *   "MRBK" (4 字节) | 头部长度 uint32 LE | 头部 JSON (UTF-8) | 数据
 *
 * 头部记录这份备份来自哪辆车、哪个 ECU 区域，以及数据的 SHA-256。
 * 恢复时据此做“傻瓜保护”：文件损坏、区域不对、不是这辆车的备份，都拒绝或强提示。
 */

export interface BackupHeader {
  format: 1;
  module: string;
  variant: string | null;
  vin: string | null;
  calIds: string[];
  region: { name: string; address: number; size: number };
  sha256: string;
  createdAt: string;
}

export interface BackupFile {
  header: BackupHeader;
  data: Uint8Array;
}

const MAGIC = [0x4d, 0x52, 0x42, 0x4b]; // "MRBK"

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function encodeBackup(
  meta: Omit<BackupHeader, 'format' | 'sha256' | 'createdAt'>,
  data: Uint8Array,
  now = new Date(),
): Promise<Uint8Array> {
  const header: BackupHeader = { format: 1, ...meta, sha256: await sha256Hex(data), createdAt: now.toISOString() };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + json.length + data.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(data, 8 + json.length);
  return out;
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

/** 解析并校验备份文件；文件损坏会抛出 BackupFormatError */
export async function decodeBackup(bytes: Uint8Array): Promise<BackupFile> {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new BackupFormatError('不是本软件的备份文件（.mrbk）');
  }
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (8 + len > bytes.length) throw new BackupFormatError('备份文件已损坏（头部不完整）');
  let header: BackupHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
  } catch {
    throw new BackupFormatError('备份文件已损坏（头部无法解析）');
  }
  if (header.format !== 1) throw new BackupFormatError(`不支持的备份格式版本：${String(header.format)}`);
  const data = bytes.slice(8 + len);
  if (data.length !== header.region.size) {
    throw new BackupFormatError(`备份文件已损坏（数据长度 ${data.length}，应为 ${header.region.size}）`);
  }
  if ((await sha256Hex(data)) !== header.sha256) {
    throw new BackupFormatError('备份文件已损坏（SHA-256 校验不通过）');
  }
  return { header, data };
}

export interface CarIdentity {
  module: string;
  vin: string | null;
}

export interface RestoreCheck {
  /** 有硬性问题，绝不允许恢复 */
  blockers: string[];
  /** 需要用户明确确认才能继续 */
  warnings: string[];
}

/** 恢复前检查：这份备份能不能写进当前这辆车 */
export function checkRestore(
  backup: BackupHeader,
  car: CarIdentity,
  region: { name: string; address: number; size: number } | undefined,
): RestoreCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (backup.module !== car.module) blockers.push(`备份来自「${backup.module}」，当前车型是「${car.module}」`);
  if (!region) {
    blockers.push(`当前 ECU 没有「${backup.region.name}」这个区域`);
  } else if (region.size !== backup.region.size || region.address !== backup.region.address) {
    blockers.push(`区域「${region.name}」的地址/大小与备份不一致，ECU 型号可能不同`);
  }
  if (backup.vin && car.vin && backup.vin !== car.vin) {
    blockers.push(`备份来自另一辆车（VIN ${backup.vin}），当前车 VIN ${car.vin}`);
  } else if (!backup.vin || !car.vin) {
    warnings.push('无法比对 VIN（备份或当前车辆没有读到 VIN），请确认这是本车的备份');
  }
  return { blockers, warnings };
}

export function backupFileName(h: Pick<BackupHeader, 'module' | 'vin' | 'region'>, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `${h.module}_${h.vin ?? 'NOVIN'}_${h.region.name}_${stamp}.mrbk`.replace(/[^\w.-]/g, '_');
}
