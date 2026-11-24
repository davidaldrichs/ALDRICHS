import { Capacitor } from '@capacitor/core';
import { Elm327, ElmError } from './core/elm327';
import { ObdService, PIDS, type PidDef } from './core/obd';
import { describeDtc as describeGenericDtc } from './core/dtc-db';
import { MODULES, availableModules, getModule, reservedModules } from './modules/registry';
import type { VehicleModule, Variant } from './platform/vehicle-module';
import type { Transport } from './transport/transport';
import { SimulatorTransport } from './transport/simulator';
import { demoFlashFor } from './modules/demo-flash';
import { demoTuningFor } from './modules/demo-tuning';
import type { TuningProvider } from './platform/tuning';
import { FlashCancelled, FlashRunner } from './platform/flash-runner';
import { backupFileName, checkRestore, decodeBackup, encodeBackup } from './platform/backup-file';
import type { FlashContext, FlashProvider } from './platform/vehicle-module';
import { desktop, isDesktop, type SerialPortItem } from './transport/desktop-api';
import { DataLogger, pidName, type LogProfile } from './core/logger';
import { parseXdf, readMap, writeMap, mapStats, type MapItem } from './platform/map-def';

type LinkKind = 'ble' | 'wifi' | 'serial' | 'demo';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const platform = Capacitor.getPlatform(); // 'web' | 'ios' | 'android'
const DESKTOP = isDesktop();

const state = {
  module: availableModules()[0] as VehicleModule,
  variant: availableModules()[0].variants[0] as Variant,
  link: (DESKTOP ? 'serial' : 'ble') as LinkKind,
  transport: null as Transport | null,
  elm: null as Elm327 | null,
  obd: null as ObdService | null,
  liveRunning: false,
  flashing: false,
  vehicle: null as { vin: string | null; calIds: string[] } | null,
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
  $('serial-opts').hidden = state.link !== 'serial';
  const hints: Record<LinkKind, string> = {
    ble:
      platform === 'ios'
        ? 'iPhone 只能连接 BLE（蓝牙 4.0）版适配器，例如 Vgate iCar Pro BLE。经典蓝牙版请改用 WiFi 版。'
        : '支持 BLE 版 ELM327。经典蓝牙（SPP）版请在后续版本中使用，或改用 WiFi 版。',
    wifi: DESKTOP
      ? '电脑先连接适配器的 WiFi 热点，默认地址 192.168.0.10:35000。'
      : platform === 'web'
        ? '浏览器里不能使用 WiFi 连接，请安装手机 App。'
        : '安卓和 iPhone 都可以使用 WiFi 版 ELM327。',
    serial: '串口 / 经典蓝牙（COM 口）版 ELM327，以及 USB K+DCAN 线。点“连接”后选择端口。',
    demo: `不需要车，用模拟数据体验全部功能（当前模拟${state.variant.isCan ? '二代 R56 / CAN' : '一代 R53 / K-Line'}）。`,
  };
  const el = document.getElementById('wifi-hint');
  if (el) el.textContent = DESKTOP ? '电脑先在系统 WiFi 里连接适配器热点（通常叫 WiFi_OBDII）。' : '先连接适配器 WiFi 热点（通常叫 WiFi_OBDII）。';
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
    case 'serial': {
      const { DesktopSerialTransport } = await import('./transport/desktop-serial');
      return new DesktopSerialTransport(Number($<HTMLSelectElement>('serial-baud').value) || 38400);
    }
    case 'wifi': {
      const host = $<HTMLInputElement>('wifi-host').value.trim() || '192.168.0.10';
      const port = Number($<HTMLInputElement>('wifi-port').value) || 35000;
      if (DESKTOP) {
        const { DesktopWifiTransport } = await import('./transport/desktop-wifi');
        return new DesktopWifiTransport(host, port);
      }
      const { WifiTransport } = await import('./transport/wifi');
      return new WifiTransport(host, port);
    }
  }
}

async function disconnect(): Promise<void> {
  state.liveRunning = false;
  const t = state.transport;
  state.transport = state.elm = state.obd = null;
  state.vehicle = null;
  if (t) await t.close().catch(() => undefined);
  setStatus('off', '未连接');
  $('btn-connect').textContent = '连接';
  renderFlashPanel();
  renderTuningPanel();
}

async function connect(): Promise<void> {
  if (state.flashing) {
    alert('正在读写 ECU，完成前不能断开！');
    return;
  }
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
    renderFlashPanel();
    renderTuningPanel();
    recRerender();
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
  if (state.flashing) {
    alert('正在读写 ECU，请等完成后再看仪表');
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

const HIDDEN_DTC_KEY = 'hiddenDtcs';
function loadHiddenDtcs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_DTC_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
function toggleHiddenDtc(code: string): void {
  const set = loadHiddenDtcs();
  if (set.has(code)) set.delete(code);
  else set.add(code);
  try {
    localStorage.setItem(HIDDEN_DTC_KEY, JSON.stringify([...set]));
  } catch {
    /* 隐私模式/禁用存储时忽略 */
  }
}

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
    const hidden = loadHiddenDtcs();
    const items: HTMLElement[] = [];
    const hiddenItems: HTMLElement[] = [];
    for (const [kind, label] of kinds) {
      const codes = await obd.readDtcs(kind).catch(() => []);
      for (const code of codes) {
        const isHidden = hidden.has(code);
        const el = document.createElement('div');
        el.className = 'dtc';
        const head = document.createElement('div');
        const c = Object.assign(document.createElement('span'), { className: 'code', textContent: code });
        const k = Object.assign(document.createElement('span'), { className: 'kind', textContent: label });
        head.append(c, k);
        const btn = document.createElement('button');
        btn.textContent = isHidden ? '取消隐藏' : '隐藏';
        btn.style.cssText = 'margin-left:auto;min-height:32px;padding:4px 10px;font-size:13px';
        head.style.cssText = 'display:flex;align-items:center';
        btn.addEventListener('click', () => {
          toggleHiddenDtc(code);
          void readDtcs();
        });
        head.append(btn);
        const d = Object.assign(document.createElement('div'), { textContent: describeDtc(code) });
        el.append(head, d);
        (isHidden ? hiddenItems : items).push(el);
      }
    }
    const out: HTMLElement[] = [];
    if (items.length) out.push(...items);
    else out.push(Object.assign(document.createElement('p'), { className: 'empty', textContent: hiddenItems.length ? '没有未隐藏的故障码 ✓' : '没有故障码 ✓' }));
    if (hiddenItems.length) {
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = `已隐藏 ${hiddenItems.length} 个（仅本软件隐藏，不影响 ECU）`;
      sum.style.cssText = 'color:var(--muted);margin:10px 0;cursor:pointer';
      det.append(sum, ...hiddenItems);
      out.push(det);
    }
    out.push(
      Object.assign(document.createElement('p'), {
        className: 'hint',
        textContent: '“隐藏”只是在本软件列表里不显示，不写 ECU、不熄故障灯。要在 ECU 里永久关闭故障码属于改程序（需解锁）；删排放设备后屏蔽排放监控码是违法失效装置，本软件不做。',
      }),
    );
    list.replaceChildren(...out);
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
  renderTuningPanel();
  renderReserved();
}

/* ---------------- 编码 / 调校（演示） ---------------- */

function currentTuningProvider(): TuningProvider | null {
  if (!state.transport) return null;
  // 真车编码/调校需要品牌协议 + 解锁，暂未开放；目前仅演示模式可用
  if (state.transport instanceof SimulatorTransport) return demoTuningFor(state.module.id);
  return null;
}

function renderTuningPanel(): void {
  const box = $('tuning-panel');
  const tuning = currentTuningProvider();
  if (!tuning) {
    box.replaceChildren(
      el('p', {
        textContent: state.transport
          ? '真车编码/调校需要该品牌的编码协议 + 解锁，暂未开放。可先用“演示模式”体验界面与流程。'
          : '连接后可做隐藏功能、大循环温度等编码/调校。没有车可用“演示模式”。',
      }),
    );
    return;
  }
  const children: HTMLElement[] = [
    el('p', { className: 'hint', textContent: '演示模式：改的是模拟 ECU 的内存值，不碰真车。真车需解锁+写入。' }),
  ];
  for (const s of tuning.list()) {
    const row = el('label', { textContent: s.name + (s.unit ? `（${s.unit}）` : '') });
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px';
    if (s.type === 'toggle') {
      const cb = el('input', { type: 'checkbox', checked: !!tuning.get(s.id) });
      cb.style.cssText = 'width:auto;margin:0';
      cb.addEventListener('change', () => {
        tuning.set(s.id, cb.checked);
        flashNote(s);
      });
      row.append(cb);
    } else {
      const inp = el('input', { type: 'number', value: String(tuning.get(s.id)) });
      inp.min = String(s.min ?? '');
      inp.max = String(s.max ?? '');
      inp.step = String(s.step ?? 1);
      inp.style.cssText = 'width:110px;margin:0';
      inp.addEventListener('change', () => {
        tuning.set(s.id, Number(inp.value));
        inp.value = String(tuning.get(s.id)); // 回填钳制后的值
        flashNote(s);
      });
      row.append(inp);
    }
    children.push(row);
    if (s.note) children.push(el('p', { className: 'hint', textContent: s.note }));
  }
  const status = el('p', { className: 'hint', id: 'tuning-status' });
  children.push(status);
  box.replaceChildren(...children);
  renderAiAdvisor(box, tuning);
}

/* ---------------- AI 调校顾问（护栏：只在安全范围内建议，人工确认） ---------------- */

interface AiCfg {
  provider: 'openai' | 'anthropic';
  endpoint: string;
  apiKey: string;
  model: string;
  goal: string;
}
function loadAiCfg(): AiCfg {
  const d: AiCfg = { provider: 'openai', endpoint: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', goal: '小幅提升动力，保守安全' };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem('aiCfg') ?? '{}') as Partial<AiCfg>) };
  } catch {
    return d;
  }
}
function saveAiCfg(c: AiCfg): void {
  try {
    localStorage.setItem('aiCfg', JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

function renderAiAdvisor(box: HTMLElement, tuning: TuningProvider): void {
  const cfg = loadAiCfg();
  const wrap = el('div');
  wrap.style.cssText = 'margin-top:14px;border-top:1px solid var(--line);padding-top:12px';
  const warn = el('p', { className: 'hint', textContent: '⚠️ AI 调校（实验）：AI 只在上面这些有范围的参数内提建议，超范围会被自动钳制，需你逐项确认才生效，不自动刷写。不碰生马力 map。' });
  const goal = el('textarea');
  goal.value = cfg.goal;
  goal.rows = 2;
  goal.placeholder = '调校目标，例如：小幅提升动力，保守安全';
  goal.style.cssText = 'width:100%;margin:6px 0;padding:8px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;font:inherit';

  const provSel = el('select');
  provSel.replaceChildren(new Option('OpenAI 兼容', 'openai'), new Option('Anthropic', 'anthropic'));
  provSel.value = cfg.provider;
  const endpoint = el('input', { value: cfg.endpoint, placeholder: '接口地址' });
  const model = el('input', { value: cfg.model, placeholder: '模型，如 gpt-4o-mini' });
  const key = el('input', { type: 'password', value: cfg.apiKey, placeholder: 'API Key（只存在本机）' });
  for (const i of [endpoint, model, key]) i.style.cssText = 'width:100%;margin:4px 0;padding:8px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px';
  const getBtn = el('button', { className: 'primary', textContent: '获取 AI 建议' });
  const result = el('div');
  result.style.marginTop = '10px';

  const persist = () => saveAiCfg({ provider: provSel.value as AiCfg['provider'], endpoint: endpoint.value.trim(), apiKey: key.value, model: model.value.trim(), goal: goal.value });
  for (const elm of [goal, provSel, endpoint, model, key]) elm.addEventListener('change', persist);
  provSel.addEventListener('change', () => {
    if (provSel.value === 'anthropic' && endpoint.value.includes('openai')) endpoint.value = 'https://api.anthropic.com';
    if (provSel.value === 'openai' && endpoint.value.includes('anthropic')) endpoint.value = 'https://api.openai.com/v1';
    persist();
  });

  getBtn.addEventListener('click', async () => {
    persist();
    if (!key.value.trim()) {
      alert('请先填 API Key');
      return;
    }
    getBtn.disabled = true;
    result.replaceChildren(el('p', { className: 'hint', textContent: 'AI 思考中…' }));
    try {
      const { proposeTuning } = await import('./platform/ai-tuning');
      const { httpAiClient } = await import('./platform/ai-client-http');
      const client = httpAiClient({ provider: provSel.value as 'openai' | 'anthropic', endpoint: endpoint.value.trim(), apiKey: key.value, model: model.value.trim() });
      const advice = await proposeTuning(tuning, goal.value, client);
      const nodes: HTMLElement[] = [];
      if (advice.notes) nodes.push(el('p', { className: 'hint', textContent: 'AI 说明：' + advice.notes }));
      if (!advice.proposals.length) nodes.push(el('p', { className: 'hint', textContent: 'AI 没有提出范围内的改动。' }));
      for (const pr of advice.proposals) {
        const row = el('div');
        row.style.cssText = 'border:1px solid var(--line);border-radius:8px;padding:8px;margin:6px 0';
        const title = el('div', { textContent: `${pr.name}: ${String(pr.from)} → ${String(pr.to)}${pr.clamped ? '（已钳到安全值）' : ''}` });
        title.style.fontWeight = '600';
        const why = el('p', { className: 'hint', textContent: pr.rationale });
        const apply = el('button', { textContent: '应用这一项' });
        apply.addEventListener('click', () => {
          tuning.set(pr.id, pr.to);
          apply.textContent = '已应用 ✓';
          apply.disabled = true;
          renderTuningPanel(); // 刷新上面的控件值
        });
        row.append(title, why, apply);
        nodes.push(row);
      }
      result.replaceChildren(...nodes);
    } catch (e) {
      result.replaceChildren(el('p', { className: 'err', textContent: 'AI 调用失败：' + errorText(e) }));
    } finally {
      getBtn.disabled = false;
    }
  });

  wrap.append(warn, goal, provSel, endpoint, model, key, getBtn, result);
  box.append(wrap);
}

function flashNote(s: { name: string }): void {
  const el2 = document.getElementById('tuning-status');
  if (el2) el2.textContent = `已更新「${s.name}」（演示：写入模拟 ECU）`;
}

/* ---------------- 一键备份 / 恢复（刷写窗口） ---------------- */

function currentFlashProvider(): FlashProvider | null {
  if (!state.transport) return null;
  if (state.transport instanceof SimulatorTransport) return demoFlashFor(state.module.id);
  return state.module.flash ?? null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function renderFlashPanel(): void {
  const box = $('flash-panel');
  const m = state.module;
  const provider = currentFlashProvider();

  if (!provider) {
    const msg = state.transport
      ? `「${m.name}」的刷写窗口已在框架中预留，但真车读写尚未开放——需要先在备用 ECU 上验证 seed/key、内存布局和校验和。可以先用“演示模式”体验一键备份/恢复的完整流程。`
      : '连接车辆后可在这里一键备份原厂程序、从备份恢复。没有车可以用“演示模式”体验。';
    box.replaceChildren(el('p', { textContent: msg }));
    return;
  }

  const isDemo = state.transport instanceof SimulatorTransport;
  const regionSel = el('select', { id: 'flash-region' });
  regionSel.replaceChildren(...provider.regions.map((r, i) => new Option(`${r.name}（0x${r.address.toString(16).toUpperCase()}，${Math.round(r.size / 1024)} KB）`, String(i))));
  const unlockBtn = el('button', { textContent: '一键解锁（试算法）' });
  const backupBtn = el('button', { className: 'primary', textContent: '一键备份原厂程序' });
  const restoreBtn = el('button', { className: 'danger', textContent: '从备份恢复…' });
  const fileInput = el('input', { type: 'file', accept: '.mrbk', hidden: true });
  const progress = el('progress', { max: 1, value: 0 });
  progress.style.cssText = 'width:100%;margin-top:10px';
  progress.hidden = true;
  const status = el('p', { className: 'hint' });
  const cancelBtn = el('button', { textContent: '取消' });
  cancelBtn.hidden = true;

  const label = el('label', { textContent: '内存区' });
  label.append(regionSel);
  const row = el('div', { className: 'row wrap' });
  row.style.marginTop = '10px';
  if (provider.probeUnlock) row.append(unlockBtn);
  row.append(backupBtn, restoreBtn, cancelBtn);
  const help = el('p', {
    className: 'hint',
    textContent:
      '备份：读出 ECU 原厂程序，存成 .mrbk 文件（含 VIN 和 SHA-256，换车或文件损坏都会被拒绝）。恢复：先自动备份当前程序，再写回、修正校验和、读回逐字节核对。全程不要熄火、断电或拔适配器，建议接充电器/稳压电源。',
  });
  box.replaceChildren(
    ...(isDemo ? [el('p', { className: 'hint', textContent: '演示模式：读写的是模拟 ECU，不会碰真车。' })] : []),
    label,
    row,
    progress,
    status,
    help,
    fileInput,
  );

  let cancelled = false;
  const setBusy = (busy: boolean) => {
    state.flashing = busy;
    unlockBtn.disabled = backupBtn.disabled = restoreBtn.disabled = regionSel.disabled = busy;
    cancelBtn.hidden = !busy;
    progress.hidden = !busy;
    $<HTMLButtonElement>('btn-connect').disabled = busy;
  };
  const ctx = (): FlashContext => ({
    elm: state.elm!,
    obd: state.obd!,
    report: (p, msg) => {
      progress.value = Math.max(0, Math.min(1, p));
      status.textContent = msg;
    },
    cancelled: () => cancelled,
  });
  const region = () => provider.regions[Number(regionSel.value) || 0];
  cancelBtn.addEventListener('click', () => {
    cancelled = true;
    status.textContent = '正在取消…';
  });

  unlockBtn.addEventListener('click', async () => {
    if (!provider.probeUnlock) return;
    if (!isDemo && !confirm('一键解锁会向 ECU 试发多个密钥。密钥连续错误会让 ECU 临时锁定（一般等几分钟自动解除）。\n\n请确认已接稳压电源、点火开关打开。继续吗？')) return;
    cancelled = false;
    state.liveRunning = false;
    setBusy(true);
    progress.removeAttribute('value'); // 不确定进度，显示忙碌
    try {
      await provider.enterProgrammingSession(ctx());
      const res = await provider.probeUnlock(ctx());
      await provider.reset(ctx()).catch(() => undefined); // 先复位，再写最终状态（避免复位进度覆盖结果）
      status.textContent = res.unlocked
        ? `✓ 解锁成功，算法：${res.algorithm?.label ?? '（ECU 已解锁）'}（试了 ${res.attempts} 种）`
        : `✗ 未解锁：${res.reason ?? '未知原因'}`;
      log('info', `一键解锁 ${res.unlocked ? '成功 ' + (res.algorithm?.id ?? '') : '失败：' + (res.reason ?? '')}`);
    } catch (e) {
      status.textContent = `解锁出错：${errorText(e)}`;
    } finally {
      progress.value = 0;
      progress.max = 1;
      setBusy(false);
    }
  });

  backupBtn.addEventListener('click', async () => {
    cancelled = false;
    state.liveRunning = false;
    setBusy(true);
    try {
      const car = await carIdentity();
      const r = region();
      const data = await new FlashRunner(provider).backup(ctx(), r);
      if (cancelled) throw new FlashCancelled();
      const meta = { module: m.id, variant: state.variant.id, vin: car.vin, calIds: car.calIds, region: { name: r.name, address: r.address, size: r.size } };
      const file = await encodeBackup(meta, data);
      await saveFile(backupFileName(meta), file);
      status.textContent = `备份完成：${Math.round(data.length / 1024)} KB，已保存。请把文件放在安全的地方（建议再复制一份到网盘）。`;
      log('info', `备份完成 ${r.name} ${data.length} 字节`);
    } catch (e) {
      status.textContent = e instanceof FlashCancelled ? '已取消备份' : `备份失败：${errorText(e)}`;
    } finally {
      setBusy(false);
    }
  });

  restoreBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    cancelled = false;
    let backup;
    try {
      backup = await decodeBackup(new Uint8Array(await f.arrayBuffer()));
    } catch (e) {
      alert(errorText(e));
      return;
    }
    const car = await carIdentity().catch(() => ({ vin: null, calIds: [] as string[] }));
    const target = provider.regions.find((r) => r.name === backup.header.region.name);
    const check = checkRestore(backup.header, { module: m.id, vin: car.vin }, target);
    if (check.blockers.length) {
      alert('不能恢复这份备份：\n\n' + check.blockers.map((b) => '• ' + b).join('\n'));
      return;
    }
    const lines = [
      `备份：${backup.header.region.name}，${Math.round(backup.data.length / 1024)} KB，${backup.header.createdAt.slice(0, 16).replace('T', ' ')}`,
      `VIN：${backup.header.vin ?? '未知'}`,
      ...check.warnings.map((w) => '⚠ ' + w),
      '',
      '恢复会覆盖 ECU 当前程序（会先自动备份当前程序）。',
      '过程中不要熄火、断电、拔适配器，否则 ECU 可能变砖。',
      '',
      '确定开始恢复吗？',
    ];
    if (!confirm(lines.join('\n'))) return;
    state.liveRunning = false;
    setBusy(true);
    try {
      const res = await new FlashRunner(provider).flash(ctx(), {
        region: target!,
        image: backup.data,
        backupFirst: true,
        minVoltage: 12.5,
        verifyAfterWrite: true,
      });
      if (res.backup) {
        const meta = { module: m.id, variant: state.variant.id, vin: car.vin, calIds: car.calIds, region: { name: target!.name, address: target!.address, size: target!.size } };
        await saveFile('pre-restore_' + backupFileName(meta), await encodeBackup(meta, res.backup));
      }
      status.textContent = '恢复完成，读回校验一致。已另存一份恢复前的程序。请熄火 10 秒后再启动。';
      log('info', `恢复完成 ${target!.name}`);
    } catch (e) {
      status.textContent = e instanceof FlashCancelled ? '已取消（尚未写入）' : `恢复失败：${errorText(e)}`;
      if (!(e instanceof FlashCancelled)) alert(`恢复失败：${errorText(e)}\n\n不要断电，保持连接，再执行一次“从备份恢复”。`);
    } finally {
      setBusy(false);
    }
  });
}

/** 读取并缓存本车身份（VIN、标定号），备份文件用它防止刷错车 */
async function carIdentity(): Promise<{ vin: string | null; calIds: string[] }> {
  if (state.vehicle) return state.vehicle;
  const obd = state.obd;
  if (!obd) return { vin: null, calIds: [] };
  const v = await obd.readVehicleInfo();
  state.vehicle = { vin: v.vin, calIds: v.calIds };
  return state.vehicle;
}

/** 保存文件：手机上用系统分享，电脑/浏览器直接下载 */
async function saveFile(name: string, bytes: Uint8Array): Promise<void> {
  const file = new File([bytes as BlobPart], name, { type: 'application/octet-stream' });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if ((platform === 'ios' || platform === 'android') && nav.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: name });
    return;
  }
  const url = URL.createObjectURL(file);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
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

/* ---------------- 连接方式按钮 + 串口选择 ---------------- */

function buildLinkSeg(): void {
  const labels: Record<LinkKind, string> = { ble: '蓝牙 BLE', serial: '串口/蓝牙', wifi: 'WiFi', demo: '演示模式' };
  const kinds: LinkKind[] = DESKTOP
    ? ['serial', 'wifi', 'demo']
    : platform === 'web'
      ? ['ble', 'demo']
      : ['ble', 'wifi', 'demo'];
  if (!kinds.includes(state.link)) state.link = kinds[0];
  $('link-seg').replaceChildren(
    ...kinds.map((k) => {
      const b = document.createElement('button');
      b.dataset.link = k;
      b.textContent = labels[k];
      if (k === state.link) b.classList.add('on');
      return b;
    }),
  );
}

function setupSerialChooser(): void {
  const d = desktop();
  if (!d) return;
  const dialog = $<HTMLDialogElement>('serial-dialog');
  const render = (list: SerialPortItem[]) => {
    const box = $('serial-ports');
    if (!list.length) {
      box.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: '没有找到串口。经典蓝牙适配器请先在系统里配对，USB 线请插好后点“重新搜索”。' }));
    } else {
      box.replaceChildren(
        ...list.map((p) => {
          const b = document.createElement('button');
          b.textContent = p.portName;
          b.style.cssText = 'display:block;width:100%;margin:6px 0;text-align:left';
          b.addEventListener('click', () => {
            d.chooseSerialPort(p.portId);
            dialog.close();
          });
          return b;
        }),
      );
    }
    if (!dialog.open) dialog.showModal();
  };
  d.onSerialList(render);
  $('serial-cancel').addEventListener('click', () => {
    d.chooseSerialPort('');
    dialog.close();
  });
  // “重新搜索”：关闭后重新触发 requestPort。交给连接流程处理，这里只关弹窗。
  $('serial-refresh').addEventListener('click', () => {
    d.chooseSerialPort('');
    dialog.close();
  });
}

/* ---------------- 启动 ---------------- */

/* ---------------- 数据记录 Log ---------------- */

let activeLogger: DataLogger | null = null;
let recRerender: () => void = () => {};

function recordChannels(): PidDef[] {
  const sup = state.obd?.supported ?? [];
  return sup.length ? PIDS.filter((p) => sup.includes(p.pid)) : PIDS;
}

function setupRecordTab(): void {
  // 通道复选框（默认勾选调校常看的几项）
  const defaults = new Set([0x0c, 0x0d, 0x0b, 0x0e, 0x05, 0x0f, 0x11]);
  const box = $('rec-channels');
  const render = () => {
    box.replaceChildren(
      ...recordChannels().map((p) => {
        const lab = el('label', { textContent: p.name });
        lab.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px';
        const cb = el('input', { type: 'checkbox', checked: defaults.has(p.pid) });
        cb.dataset.pid = String(p.pid);
        cb.style.cssText = 'width:auto;margin:0';
        lab.prepend(cb);
        return lab;
      }),
    );
    const tsel = $<HTMLSelectElement>('rec-trig-ch');
    tsel.replaceChildren(...recordChannels().map((p) => new Option(p.name, String(p.pid))));
    tsel.value = String(0x11); // 默认节气门
  };
  render();
  recRerender = render;

  $('rec-auto').addEventListener('change', (e) => {
    $('rec-trigger').hidden = !(e.target as HTMLInputElement).checked;
  });
  const startBtn = $<HTMLButtonElement>('rec-start');
  startBtn.addEventListener('click', () => void startRecording());
  $('rec-stop').addEventListener('click', () => activeLogger?.stop());
  $('rec-export').addEventListener('click', exportLog);
  const aiBtn = $<HTMLButtonElement>('rec-ai');
  aiBtn.addEventListener('click', () => withBusy(aiBtn, aiLogProfile));
}

function selectedChannels(): number[] {
  return [...document.querySelectorAll<HTMLInputElement>('#rec-channels input:checked')].map((c) => Number(c.dataset.pid));
}

function buildProfile(): LogProfile | null {
  const channels = selectedChannels();
  if (!channels.length) {
    alert('请至少勾选一个通道');
    return null;
  }
  const intervalMs = Math.max(20, Number($<HTMLInputElement>('rec-interval').value) || 100);
  const profile: LogProfile = { channels, intervalMs };
  if ($<HTMLInputElement>('rec-auto').checked) {
    const stopAfter = Number($<HTMLInputElement>('rec-stop-after').value);
    profile.trigger = {
      startPid: Number($<HTMLSelectElement>('rec-trig-ch').value),
      startOp: $<HTMLSelectElement>('rec-trig-op').value as '>' | '<' | '>=' | '<=',
      startValue: Number($<HTMLInputElement>('rec-trig-val').value) || 0,
      stopAfterS: stopAfter > 0 ? stopAfter : undefined,
      stopWhenConditionClears: $<HTMLInputElement>('rec-stop-clear').checked,
    };
  }
  return profile;
}

async function startRecording(): Promise<void> {
  const obd = requireObd();
  if (!obd) return;
  if (activeLogger && (activeLogger.state === 'armed' || activeLogger.state === 'recording')) return;
  const profile = buildProfile();
  if (!profile) return;
  state.liveRunning = false; // 让出通讯
  const byPid = new Map(PIDS.map((p) => [p.pid, p]));
  const status = $('rec-status');
  const preview = $('rec-preview');
  let count = 0;
  const since = performance.now();
  const logger = new DataLogger({
    profile,
    read: (pid) => {
      const def = byPid.get(pid);
      return def ? obd.readPid(def) : Promise.resolve(null);
    },
    onState: (s) => {
      const label = { idle: '空闲', armed: '待触发（满足条件自动开始）…', recording: '记录中…', stopped: '已停止' }[s];
      status.textContent = label;
      $<HTMLButtonElement>('rec-start').disabled = s === 'armed' || s === 'recording';
      $<HTMLButtonElement>('rec-stop').disabled = !(s === 'armed' || s === 'recording');
    },
    onRow: () => {
      count++;
      const rate = (count * 1000) / Math.max(1, performance.now() - since);
      status.textContent = `记录中… ${logger.rows.length} 行 · ${rate.toFixed(1)} 行/秒`;
      if (count % 3 === 0 || logger.rows.length < 5) {
        const chans = profile.channels;
        const head = ['t(ms)', ...chans.map((c) => pidName(c))].join('  ');
        const last = logger.rows.slice(-6).map((r) => [r.t, ...chans.map((c) => r.values[c] ?? '-')].join('  ')).join('\n');
        preview.textContent = head + '\n' + last;
      }
    },
  });
  activeLogger = logger;
  preview.textContent = '';
  await logger.run().catch((e) => {
    status.textContent = '记录出错：' + errorText(e);
  });
}

async function exportLog(): Promise<void> {
  if (!activeLogger || !activeLogger.rows.length) {
    alert('还没有记录数据');
    return;
  }
  const name = `log_${state.module.id}_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.csv`;
  try {
    await saveFile(name, new TextEncoder().encode(activeLogger.toCsv()));
    $('rec-status').textContent = `已导出 ${activeLogger.rows.length} 行到 ${name}`;
  } catch (e) {
    $('rec-status').textContent = '导出失败：' + errorText(e);
  }
}

/** AI 按一句话生成记录方案（选通道 + 触发条件） */
async function aiLogProfile(): Promise<void> {
  const goal = prompt('想记录什么？例如：记录一次全油门加速时的增压、点火、转速', '记录一次全油门加速（增压/点火/转速/车速）');
  if (!goal) return;
  const cfg = loadAiCfg();
  if (!cfg.apiKey) {
    alert('请先在“编码/调校”页的 AI 区填好 API Key');
    switchTab('code');
    return;
  }
  const status = $('rec-status');
  status.textContent = 'AI 生成记录方案中…';
  try {
    const { httpAiClient } = await import('./platform/ai-client-http');
    const client = httpAiClient({ provider: cfg.provider, endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model });
    const list = recordChannels().map((p) => `${p.pid}(${p.name}${p.unit ? '/' + p.unit : ''})`).join('、');
    const sys = '你是汽车数据记录助手。只输出一个 JSON:{"channels":[PID数字...],"trigger":{"startPid":数字,"startOp":">"或"<","startValue":数字,"stopAfterS":数字}}。trigger 可省略表示手动。只用给定的 PID 数字。';
    const user = `目标:${goal}\n可用通道(PID):${list}\n只返回 JSON。`;
    const raw = await client.complete({ system: sys, user });
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { channels?: number[]; trigger?: { startPid?: number; startOp?: string; startValue?: number; stopAfterS?: number } };
    const valid = new Set(recordChannels().map((p) => p.pid));
    const chans = (j.channels ?? []).filter((c) => valid.has(c));
    if (!chans.length) throw new Error('AI 没给出有效通道');
    // 应用到界面
    document.querySelectorAll<HTMLInputElement>('#rec-channels input').forEach((cb) => (cb.checked = chans.includes(Number(cb.dataset.pid))));
    if (j.trigger?.startPid && valid.has(j.trigger.startPid)) {
      ($('rec-auto') as HTMLInputElement).checked = true;
      $('rec-trigger').hidden = false;
      $<HTMLSelectElement>('rec-trig-ch').value = String(j.trigger.startPid);
      if (j.trigger.startOp) $<HTMLSelectElement>('rec-trig-op').value = j.trigger.startOp;
      if (j.trigger.startValue !== undefined) $<HTMLInputElement>('rec-trig-val').value = String(j.trigger.startValue);
      if (j.trigger.stopAfterS !== undefined) $<HTMLInputElement>('rec-stop-after').value = String(j.trigger.stopAfterS);
    }
    status.textContent = `AI 已生成方案:记录 ${chans.map((c) => pidName(c)).join('、')}${j.trigger ? '，自动触发已设好' : ''}。点“开始记录”。`;
  } catch (e) {
    status.textContent = 'AI 生成失败：' + errorText(e);
  }
}

/* ---------------- Map 调校（XDF） ---------------- */

const mapState: { rom: Uint8Array | null; maps: MapItem[] } = { rom: null, maps: [] };

function demoXdfAndRom(): { xml: string; rom: Uint8Array } {
  const xml = `<XDFFORMAT version="1.60"><XDFHEADER><BASEOFFSET offset="0" subtract="0"/></XDFHEADER>
<XDFCONSTANT uniqueid="0x1"><title>增压限制(示例)</title><EMBEDDEDDATA mmedaddress="0x10" mmedelementsizebits="16" mmedtypeflags="0x0"/><units>kPa</units><MATH equation="X*0.1"><VAR id="X"/></MATH><rangelow>80</rangelow><rangehigh>250</rangehigh></XDFCONSTANT>
<XDFTABLE uniqueid="0x2"><title>点火提前(示例 4x4)</title><XDFAXIS id="z"><EMBEDDEDDATA mmedaddress="0x20" mmedelementsizebits="8" mmedrowcount="4" mmedcolcount="4" mmedtypeflags="0x0"/><units>°</units><MATH equation="X*0.75-24"><VAR id="X"/></MATH></XDFAXIS></XDFTABLE></XDFFORMAT>`;
  const rom = new Uint8Array(0x100);
  new DataView(rom.buffer).setUint16(0x10, 1500, false); // 150 kPa
  for (let i = 0; i < 16; i++) rom[0x20 + i] = 140 + (i % 4) * 4; // 点火基准
  return { xml, rom };
}

function loadXdfText(xml: string): void {
  try {
    mapState.maps = parseXdf(xml, { endian: 'big' });
    renderMapList();
    $('map-status').textContent = `已载入 ${mapState.maps.length} 个 map${mapState.rom ? '' : '（还需载入 ROM 才能读值）'}`;
  } catch (e) {
    $('map-status').textContent = 'XDF 解析失败：' + errorText(e);
  }
}

async function loadRomFile(file: File): Promise<Uint8Array> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.name.endsWith('.mrbk')) {
    const { decodeBackup } = await import('./platform/backup-file');
    return (await decodeBackup(bytes)).data;
  }
  return bytes;
}

function renderMapList(): void {
  const box = $('map-list');
  if (!mapState.maps.length) {
    box.replaceChildren();
    return;
  }
  $<HTMLButtonElement>('map-export').disabled = !mapState.rom;
  const rom = mapState.rom;
  box.replaceChildren(
    ...mapState.maps.map((m) => {
      const card = el('div');
      card.style.cssText = 'border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0';
      const head = el('div', { textContent: `${m.title}  ·  ${m.kind === 'scalar' ? '标量' : `${m.rows}×${m.cols} 表`}  ${m.unit ? '(' + m.unit + ')' : ''}` });
      head.style.fontWeight = '600';
      card.append(head);
      card.append(el('p', { className: 'hint', textContent: `地址 0x${m.address.toString(16)} · ${m.sizeBits}位${m.signed ? '有符号' : ''} · ${m.linear ? '可改' : '只读(非线性)'}` }));
      if (!rom) {
        card.append(el('p', { className: 'hint', textContent: '载入 ROM 后显示数值。' }));
        return card;
      }
      let values: number[];
      try {
        values = readMap(rom, m);
      } catch (e) {
        card.append(el('p', { className: 'err', textContent: '读取失败：' + errorText(e) }));
        return card;
      }
      const status = el('p', { className: 'hint' });
      if (m.kind === 'scalar') {
        status.textContent = `当前：${values[0].toFixed(2)} ${m.unit}`;
        if (m.linear) {
          const inp = el('input', { type: 'number', value: String(round2(values[0])) });
          inp.style.cssText = 'width:120px;margin:0 8px 0 0';
          const btn = el('button', { textContent: '应用' });
          btn.addEventListener('click', () => {
            mapState.rom = writeMap(mapState.rom!, m, [Number(inp.value)]);
            renderMapList();
            $('map-status').textContent = `已改「${m.title}」→ ${readMap(mapState.rom!, m)[0].toFixed(2)} ${m.unit}`;
          });
          const row = el('div', { className: 'row wrap' });
          row.append(inp, btn);
          card.append(status, row);
        } else card.append(status);
      } else {
        const st = mapStats(values);
        status.textContent = `最小 ${round2(st.min)} / 平均 ${round2(st.mean)} / 最大 ${round2(st.max)} ${m.unit}`;
        card.append(status);
        if (m.linear) {
          const pct = el('input', { type: 'number', value: '100' });
          pct.style.cssText = 'width:90px;margin:0 8px 0 0';
          const btn = el('button', { textContent: '整体 ×% 应用' });
          btn.addEventListener('click', () => {
            const f = (Number(pct.value) || 100) / 100;
            if (!confirm(`把「${m.title}」整张表 ×${pct.value}%？改的是文件副本，刷写前会被范围钳制。`)) return;
            mapState.rom = writeMap(mapState.rom!, m, readMap(mapState.rom!, m).map((v) => v * f));
            renderMapList();
            $('map-status').textContent = `已把「${m.title}」×${pct.value}%`;
          });
          const row = el('div', { className: 'row wrap' });
          row.append(el('span', { className: 'hint', textContent: '整体缩放' }), pct, btn);
          card.append(row);
        }
      }
      return card;
    }),
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function setupMapPanel(): void {
  $('map-xdf').addEventListener('click', () => $('map-xdf-file').click());
  $('map-rom').addEventListener('click', () => $('map-rom-file').click());
  $('map-xdf-file').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (f) loadXdfText(await f.text());
  });
  $('map-rom-file').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!f) return;
    try {
      mapState.rom = await loadRomFile(f);
      renderMapList();
      $('map-status').textContent = `已载入 ROM ${Math.round(mapState.rom.length / 1024)} KB${mapState.maps.length ? '' : '（还需导入 XDF）'}`;
    } catch (err) {
      $('map-status').textContent = '载入 ROM 失败：' + errorText(err);
    }
  });
  $('map-demo').addEventListener('click', () => {
    const { xml, rom } = demoXdfAndRom();
    mapState.rom = rom;
    loadXdfText(xml);
    $('map-status').textContent = '已载入演示 XDF + ROM，可试改。';
  });
  $('map-export').addEventListener('click', async () => {
    if (!mapState.rom) return;
    await saveFile(`rom_modified_${new Date().toISOString().slice(0, 10)}.bin`, mapState.rom);
  });
}

function init(): void {
  buildLinkSeg();
  if (DESKTOP) setupSerialChooser();
  setupRecordTab();
  setupMapPanel();
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
