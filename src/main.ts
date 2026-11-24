import { Capacitor } from '@capacitor/core';
import { Elm327, ElmError } from './core/elm327';
import { ObdService, PIDS, type PidDef } from './core/obd';
import { describeDtc as describeGenericDtc } from './core/dtc-db';
import { MODULES, availableModules, getModule, reservedModules } from './modules/registry';
import type { VehicleModule, Variant } from './platform/vehicle-module';
import type { Transport } from './transport/transport';
import { SimulatorTransport } from './transport/simulator';

type LinkKind = 'ble' | 'wifi' | 'demo';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const platform = Capacitor.getPlatform(); // 'web' | 'ios' | 'android'

const state = {
  module: availableModules()[0] as VehicleModule,
  variant: availableModules()[0].variants[0] as Variant,
  link: 'ble' as LinkKind,
  transport: null as Transport | null,
  elm: null as Elm327 | null,
  obd: null as ObdService | null,
  liveRunning: false,
};

function describeDtc(code: string): string {
  return state.module.describeDtc?.(code) ?? describeGenericDtc(code);
}

/* ---------------- 日志 ---------------- */

const logLines: string[] = [];
function log(dir: 'tx' | 'rx' | 'info', text: string): void {
  const t = new Date().toTimeString().slice(0, 8);
  const prefix = { tx: '>>', rx: '<<', info: '--' }[dir];
  logLines.push(`${t} ${prefix} ${text.replace(/\n/g, ' | ')}`);
  if (logLines.length > 1000) logLines.splice(0, logLines.length - 1000);
  const el = $('log');
  if (el.closest('.tab')?.classList.contains('active')) renderLog();
}
function renderLog(): void {
  const el = $('log');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

/* ---------------- 通用 UI ---------------- */

function setStatus(kind: 'off' | 'busy' | 'on', text: string): void {
  const el = $('status');
  el.className = `status ${kind}`;
  el.textContent = text;
}

function errorText(e: unknown): string {
  if (e instanceof ElmError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function requireObd(): ObdService | null {
  if (state.obd) return state.obd;
  alert('请先在“连接”页连接 OBD 适配器');
  switchTab('connect');
  return null;
}

async function withBusy(btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.disabled = false;
  }
}

function switchTab(name: string): void {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  document.querySelectorAll<HTMLButtonElement>('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'log') renderLog();
  window.scrollTo(0, 0);
}

function segment(containerId: string, attr: string, onChange: (v: string) => void): void {
  const box = $(containerId);
  box.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button');
    if (!btn || !btn.dataset[attr]) return;
    box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    onChange(btn.dataset[attr]!);
  });
}

/* ---------------- 连接页 ---------------- */

function fillModules(): void {
  const sel = $<HTMLSelectElement>('module');
  sel.replaceChildren(
    ...MODULES.map((m) => {
      const label = m.status === 'reserved' ? `${m.name}（即将支持）` : m.name;
      const opt = new Option(label, m.id);
      opt.disabled = m.status === 'reserved';
      return opt;
    }),
  );
  sel.value = state.module.id;
  fillVariants();
}

function fillVariants(): void {
  const box = $('variant-seg');
  box.replaceChildren(
    ...state.module.variants.map((v, i) => {
      const b = document.createElement('button');
      b.dataset.variant = v.id;
      b.textContent = v.label;
      if (v.id === state.variant.id || (state.module.variants.indexOf(state.variant) < 0 && i === 0)) {
        b.classList.add('on');
        state.variant = v;
      }
      return b;
    }),
  );
  fillChassis();
}

function fillChassis(): void {
  const sel = $<HTMLSelectElement>('chassis');
  sel.replaceChildren(...state.variant.subModels.map((c) => new Option(`${c.code} ${c.name}（${c.years}）`, c.code)));
  fillEngines();
}

function fillEngines(): void {
  const chassis = state.variant.subModels.find((c) => c.code === $<HTMLSelectElement>('chassis').value);
  const sel = $<HTMLSelectElement>('engine');
  sel.replaceChildren(...(chassis?.powertrains ?? []).map((e) => new Option(`${e.code} — ${e.desc}`, e.code)));
  updateChassisHint();
}

function updateChassisHint(): void {
  const chassis = state.variant.subModels.find((c) => c.code === $<HTMLSelectElement>('chassis').value);
  const engine = chassis?.powertrains.find((e) => e.code === $<HTMLSelectElement>('engine').value);
  $('chassis-hint').textContent =
    `${state.module.name} · ${state.variant.label} · 通讯方式：${state.variant.protocol}` +
    (engine ? ` · 常见 ECU：${engine.ecu}` : '');
}

function updateLinkHint(): void {
  $('wifi-opts').hidden = state.link !== 'wifi';
  const hints: Record<LinkKind, string> = {
    ble:
      platform === 'ios'
        ? 'iPhone 只能连接 BLE（蓝牙 4.0）版适配器，例如 Vgate iCar Pro BLE。经典蓝牙版请改用 WiFi 版。'
        : '支持 BLE 版 ELM327。经典蓝牙（SPP）版请在后续版本中使用，或改用 WiFi 版。',
    wifi: platform === 'web' ? '浏览器里不能使用 WiFi 连接，请安装手机 App。' : '安卓和 iPhone 都可以使用 WiFi 版 ELM327。',
    demo: `不需要车，用模拟数据体验全部功能（当前模拟${state.variant.isCan ? '二代 R56 / CAN' : '一代 R53 / K-Line'}）。`,
  };
  $('link-hint').textContent = hints[state.link];
}

async function createTransport(): Promise<Transport> {
  switch (state.link) {
    case 'demo':
      return new SimulatorTransport(state.variant.isCan ? 2 : 1);
    case 'ble': {
      const { BleTransport } = await import('./transport/ble');
      return new BleTransport();
    }
    case 'wifi': {
      const { WifiTransport } = await import('./transport/wifi');
      const port = Number($<HTMLInputElement>('wifi-port').value) || 35000;
      return new WifiTransport($<HTMLInputElement>('wifi-host').value.trim() || '192.168.0.10', port);
    }
  }
}

async function disconnect(): Promise<void> {
  state.liveRunning = false;
  const t = state.transport;
  state.transport = state.elm = state.obd = null;
  if (t) await t.close().catch(() => undefined);
  setStatus('off', '未连接');
  $('btn-connect').textContent = '连接';
}

async function connect(): Promise<void> {
  if (state.transport) {
    await disconnect();
    return;
  }
  setStatus('busy', '连接中…');
  let transport: Transport | null = null;
  try {
    transport = await createTransport();
    await transport.open();
    log('info', `已连接 ${transport.label}`);
    const elm = new Elm327(transport, log);
    transport.onClose(() => {
      if (state.transport === transport) {
        log('info', '适配器连接已断开');
        void disconnect();
      }
    });
    state.transport = transport;
    setStatus('busy', '初始化…');
    const info = await elm.initialize();
    state.elm = elm;
    state.obd = new ObdService(elm);
    await state.obd.loadSupportedPids();

    const ident = state.module.identify?.(elm, state.obd);
    if (ident && ident.variantId && ident.variantId !== state.variant.id) {
      log('info', ident.note);
      alert(`${ident.note}，与所选（${state.variant.label}）不一致，请检查车型选择。`);
    }
    setStatus('on', info.isCan ? '已连接 · CAN' : '已连接 · K-Line');
    $('btn-connect').textContent = '断开';
    renderGauges();
    switchTab('dtc');
  } catch (e) {
    log('info', `连接失败：${errorText(e)}`);
    state.transport = null;
    if (transport) await transport.close().catch(() => undefined);
    await disconnect();
    alert(`连接失败：${errorText(e)}`);
  }
}

/* ---------------- 仪表页 ---------------- */

interface Gauge {
  name: string;
  unit: string;
  digits: number;
  valEl: HTMLElement;
}
let gauges = new Map<string, Gauge>();

function livePids(): PidDef[] {
  const sup = state.obd?.supported ?? [];
  return sup.length ? PIDS.filter((p) => sup.includes(p.pid)) : PIDS;
}

function renderGauges(): void {
  const box = $('gauges');
  gauges = new Map();
  const defs: Array<{ key: string; name: string; unit: string; digits: number }> = livePids().map((p) => ({
    key: String(p.pid),
    name: p.name,
    unit: p.unit,
    digits: p.digits ?? 0,
  }));
  if (defs.some((d) => d.key === String(0x0b)) && defs.some((d) => d.key === String(0x33))) {
    defs.splice(2, 0, { key: 'boost', name: '增压值', unit: 'bar', digits: 2 });
  }
  box.replaceChildren(
    ...defs.map((d) => {
      const el = document.createElement('div');
      el.className = 'gauge';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = d.name;
      const val = document.createElement('div');
      val.className = 'val';
      val.textContent = '--';
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = d.unit;
      const wrap = document.createElement('div');
      wrap.append(val, unit);
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'baseline';
      el.append(name, wrap);
      gauges.set(d.key, { name: d.name, unit: d.unit, digits: d.digits, valEl: val });
      return el;
    }),
  );
}

function setGauge(key: string, v: number | null): void {
  const g = gauges.get(key);
  if (g) g.valEl.textContent = v === null ? '--' : v.toFixed(g.digits);
}

async function toggleLive(): Promise<void> {
  const btn = $<HTMLButtonElement>('btn-live');
  if (state.liveRunning) {
    state.liveRunning = false;
    return;
  }
  const obd = requireObd();
  if (!obd) return;
  if (!gauges.size) renderGauges();
  state.liveRunning = true;
  btn.textContent = '停止';
  const values = new Map<number, number | null>();
  let count = 0;
  let since = performance.now();
  try {
    while (state.liveRunning && state.obd === obd) {
      for (const def of livePids()) {
        if (!state.liveRunning) break;
        const v = await obd.readPid(def).catch(() => null);
        values.set(def.pid, v);
        setGauge(String(def.pid), v);
        count++;
      }
      const map = values.get(0x0b);
      const baro = values.get(0x33);
      setGauge('boost', map != null && baro != null ? (map - baro) / 100 : null);
      const now = performance.now();
      if (now - since > 2000) {
        $('live-rate').textContent = `刷新速度 ${((count * 1000) / (now - since)).toFixed(1)} 项/秒`;
        count = 0;
        since = now;
      }
    }
  } finally {
    state.liveRunning = false;
    btn.textContent = '开始读取';
  }
}

/* ---------------- 故障码页 ---------------- */

async function readDtcs(): Promise<void> {
  const obd = requireObd();
  if (!obd) return;
  const list = $('dtc-list');
  list.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: '读取中…' }));
  try {
    const mil = await obd.readMil().catch(() => null);
    $('dtc-mil').textContent = mil
      ? `故障灯：${mil.milOn ? '亮' : '灭'} · ECU 记录的故障数：${mil.dtcCount}`
      : '';
    const kinds = [
      ['stored', '已确认'],
      ['pending', '待定'],
      ['permanent', '永久'],
    ] as const;
    const items: HTMLElement[] = [];
    for (const [kind, label] of kinds) {
      const codes = await obd.readDtcs(kind).catch(() => []);
      for (const code of codes) {
        const el = document.createElement('div');
        el.className = 'dtc';
        const head = document.createElement('div');
        const c = Object.assign(document.createElement('span'), { className: 'code', textContent: code });
        const k = Object.assign(document.createElement('span'), { className: 'kind', textContent: label });
        head.append(c, k);
        const d = Object.assign(document.createElement('div'), { textContent: describeDtc(code) });
        el.append(head, d);
        items.push(el);
      }
    }
    list.replaceChildren(
      ...(items.length
        ? items
        : [Object.assign(document.createElement('p'), { className: 'empty', textContent: '没有故障码 ✓' })]),
    );
  } catch (e) {
    list.replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: errorText(e) }));
  }
}

async function clearDtcs(): Promise<void> {
  const obd = requireObd();
  if (!obd) return;
  const ok = confirm(
    '清除故障码会同时清除冻结帧数据和排放就绪状态（年检前不要清）。\n\n请确认：点火开关打开、发动机熄火。\n\n确定清除吗？',
  );
  if (!ok) return;
  try {
    const done = await obd.clearDtcs();
    alert(done ? '已清除。如果故障仍然存在，故障码会再次出现。' : 'ECU 没有确认清除，请熄火后重试。');
    await readDtcs();
  } catch (e) {
    alert(`清除失败：${errorText(e)}`);
  }
}

/* ---------------- 车辆信息页 ---------------- */

async function readInfo(): Promise<void> {
  const obd = requireObd();
  if (!obd || !state.elm?.info) return;
  const dl = $('info-list');
  const rows: Array<[string, string]> = [];
  const render = () =>
    dl.replaceChildren(
      ...rows.flatMap(([k, v]) => [
        Object.assign(document.createElement('dt'), { textContent: k }),
        Object.assign(document.createElement('dd'), { textContent: v }),
      ]),
    );
  const info = state.elm.info;
  rows.push(['适配器', info.version], ['通讯协议', `${info.protocol}（${info.protocolNumber}）`], ['电压', info.voltage || '-']);
  rows.push(['读取中', '…']);
  render();
  try {
    const v = await obd.readVehicleInfo();
    rows.pop();
    rows.push(['VIN', v.vin ?? '读不到（部分一代车型的 ECU 不提供）']);
    if (v.vin) {
      const g = state.module.analyzeVin?.(v.vin);
      if (g) rows.push(['VIN 分析', g.note]);
    }
    rows.push(['判断底盘', info.isCan ? '二代（CAN）' : '一代（K-Line）']);
    rows.push(['ECU 名称', v.ecuName ?? '-']);
    rows.push(['标定号 CALID', v.calIds.join('\n') || '-']);
    rows.push(['校验码 CVN', v.cvns.join('\n') || '-']);
    if (v.mil) rows.push(['故障灯', `${v.mil.milOn ? '亮' : '灭'}（${v.mil.dtcCount} 个故障）`]);
    rows.push(['支持的数据项', `${v.supportedPids.length} 个`]);
  } catch (e) {
    rows.pop();
    rows.push(['错误', errorText(e)]);
  }
  render();
}

/* ---------------- 编码 / 刷写页 ---------------- */

function cell(tag: 'td' | 'th' | 'p', text: string): HTMLElement {
  return Object.assign(document.createElement(tag), { textContent: text });
}

function renderCaps(): void {
  $('caps-title').textContent = `${state.module.name} · 功能支持情况`;
  const t = $('caps');
  const head = document.createElement('tr');
  head.append(cell('th', '功能'), cell('th', '说明'), cell('th', '状态'));
  const rows = state.module.features.map((f) => {
    const tr = document.createElement('tr');
    tr.append(cell('td', f.name), cell('td', f.note ?? '-'));
    const td = document.createElement('td');
    const label = { ready: '可用', planned: '开发中', unsupported: '不支持' }[f.status];
    td.append(Object.assign(document.createElement('span'), { className: `badge ${f.status}`, textContent: label }));
    tr.append(td);
    return tr;
  });
  t.replaceChildren(head, ...rows);
  renderFlashPanel();
  renderReserved();
}

function renderFlashPanel(): void {
  const box = $('flash-panel');
  const m = state.module;
  if (m.flash) {
    const p = cell('p', `本车型已开放刷写，可读写 ${m.flash.regions.length} 个内存区。刷写前请接稳压电源并备份原厂程序。`);
    box.replaceChildren(p);
  } else {
    const p = cell('p', `「${m.name}」的刷写窗口已在框架中预留，但尚未开放——刷写流程（会话→seed/key→擦写→校验→复位）已通用化，待在真车和备用 ECU 上验证私有协议后即可开放。`);
    const hint = Object.assign(cell('p', '在此之前请使用成熟工具：BimmerCode（编码）、Deep OBD（开源，安卓）。'), { className: 'hint' });
    box.replaceChildren(p, hint);
  }
}

function renderReserved(): void {
  const t = $('reserved-list');
  const head = document.createElement('tr');
  head.append(cell('th', '平台'), cell('th', '说明'));
  const rows = reservedModules().map((m) => {
    const tr = document.createElement('tr');
    tr.append(cell('td', m.name), cell('td', m.reservedNote ?? ''));
    return tr;
  });
  t.replaceChildren(head, ...rows);
}

/* ---------------- 日志页 ---------------- */

async function sendRaw(): Promise<void> {
  const input = $<HTMLInputElement>('raw-cmd');
  const cmd = input.value.trim().toUpperCase();
  if (!cmd) return;
  if (!state.elm) {
    alert('请先连接适配器');
    return;
  }
  // 防止误发写入/刷写类服务：只允许 AT 命令和只读的 OBD 服务
  if (!/^AT/.test(cmd) && !/^0[1-9A]/.test(cmd)) {
    alert('为了安全，这里只允许 AT 命令和标准 OBD 读取命令（01–0A）。');
    return;
  }
  if (/^04/.test(cmd) && !confirm('04 会清除故障码，确定发送吗？')) return;
  try {
    await state.elm.send(cmd, 10000);
  } catch (e) {
    log('info', errorText(e));
  }
  renderLog();
}

/* ---------------- 启动 ---------------- */

function init(): void {
  $('module').addEventListener('change', (ev) => {
    const m = getModule((ev.target as HTMLSelectElement).value);
    if (!m || m.status === 'reserved') return;
    state.module = m;
    state.variant = m.variants[0];
    fillVariants();
    updateLinkHint();
    renderCaps();
  });
  segment('variant-seg', 'variant', (id) => {
    const v = state.module.variants.find((x) => x.id === id);
    if (v) state.variant = v;
    fillChassis();
    updateLinkHint();
  });
  segment('link-seg', 'link', (v) => {
    state.link = v as LinkKind;
    updateLinkHint();
  });
  $('chassis').addEventListener('change', fillEngines);
  $('engine').addEventListener('change', updateChassisHint);
  document.querySelector('.tabbar')!.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (b?.dataset.tab) switchTab(b.dataset.tab);
  });

  const connectBtn = $<HTMLButtonElement>('btn-connect');
  connectBtn.addEventListener('click', () => withBusy(connectBtn, connect));
  $('btn-live').addEventListener('click', () => void toggleLive());
  const dtcBtn = $<HTMLButtonElement>('btn-dtc-read');
  dtcBtn.addEventListener('click', () => withBusy(dtcBtn, readDtcs));
  const clearBtn = $<HTMLButtonElement>('btn-dtc-clear');
  clearBtn.addEventListener('click', () => withBusy(clearBtn, clearDtcs));
  const infoBtn = $<HTMLButtonElement>('btn-info');
  infoBtn.addEventListener('click', () => withBusy(infoBtn, readInfo));
  $('btn-raw').addEventListener('click', () => void sendRaw());
  $('raw-cmd').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void sendRaw();
  });
  $('btn-log-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(logLines.join('\n'));
      alert('日志已复制');
    } catch {
      alert('复制失败，请长按日志手动复制');
    }
  });

  fillModules();
  updateLinkHint();
  renderCaps();
  renderGauges();
}

init();
