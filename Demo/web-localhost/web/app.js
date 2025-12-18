const $ = (id) => document.getElementById(id);

const LS_KEY = 'st8504.uhf.localhost.v1';
const LS_THEME_KEY = 'st8504.theme';

// Theme management
function getTheme() {
  try {
    const saved = localStorage.getItem(LS_THEME_KEY);
    return saved === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function setTheme(theme) {
  const validTheme = theme === 'dark' ? 'dark' : 'light';
  try {
    localStorage.setItem(LS_THEME_KEY, validTheme);
  } catch {
    // ignore
  }
  document.documentElement.setAttribute('data-theme', validTheme);
  updateThemeButton(validTheme);
}

function toggleTheme() {
  const current = getTheme();
  const next = current === 'light' ? 'dark' : 'light';
  setTheme(next);
}

function updateThemeButton(theme) {
  const btn = $('themeToggle');
  if (!btn) return;
  if (theme === 'dark') {
    btn.textContent = 'Light';
    btn.title = 'Light mode (oq) ga o\'zgartirish';
  } else {
    btn.textContent = 'Dark';
    btn.title = 'Dark mode (qora) ga o\'zgartirish';
  }
}

const TAB_SCHEMA = {
  reader: {
    label: 'Reader Setting',
    subs: {
      basic: 'Basic',
      rtSetting: 'Real-time-inventory setting',
      addFunction: 'Add-Function',
    },
  },
  c1g2: {
    label: 'EPCC1-G2',
    subs: {
      realtime: 'Real-time-inventory',
      tags: 'Taglar / Antenna',
      antenna: 'Antenna bo‘yicha',
      buffer: 'Buffer operation',
      fast: 'Fast-mode',
      rw: 'Read/Write Tag',
    },
  },
  gjb: { label: 'GJB-test', subs: { main: 'GJB-test' } },
  iso6b: { label: '18000-6B', subs: { main: '18000-6B' } },
  net: {
    label: 'Network module config',
    subs: {
      tcp: 'TCP config',
      tcpnl: 'TCP config-NL',
      serial: 'Serialport Config',
      server: 'TCP Server',
      client: 'TCP Client',
    },
  },
  aloqa: { label: 'Aloqa', subs: { main: 'Aloqa' } },
};

const MAIN_TABS = Object.keys(TAB_SCHEMA);
const DEFAULT_SUBS = {
  reader: 'basic',
  c1g2: 'realtime',
  gjb: 'main',
  iso6b: 'main',
  net: 'tcp',
  aloqa: 'main',
};

let activeMain = 'reader';
let activeSubs = { ...DEFAULT_SUBS };
let pendingBasicState = null;

function logLine(msg) {
  const el = $('logs');
  const t = new Date().toISOString().replace('T', ' ').replace('Z', '');
  if (!el) return;
  el.textContent = `[${t}] ${msg}\n` + el.textContent;
}

function setText(id, value) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(value ?? '');
}

function toast(message, kind = 'ok', { ttlMs = 4500 } = {}) {
  const wrap = $('toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${kind || ''}`.trim();
  el.textContent = String(message);
  wrap.appendChild(el);

  const remove = () => {
    try {
      el.remove();
    } catch {
      // ignore
    }
  };

  el.addEventListener('click', remove);
  window.setTimeout(remove, ttlMs);
}

function downloadTextFile(filename, text, mime = 'text/plain') {
  const name = String(filename || 'download.txt');
  const body = String(text ?? '');
  const blob = new Blob([body], { type: `${mime}; charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch (e) {
    try {
      setBackend('err');
    } catch {
      // ignore
    }
    throw new Error('Serverga ulanib bo‘lmadi. `./start-web.sh` ishlayaptimi?');
  }
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'So‘rov bajarilmadi');
  return data.result ?? data;
}

async function apiGet(path) {
  let res;
  try {
    res = await fetch(path, { method: 'GET', cache: 'no-store' });
  } catch (e) {
    try {
      setBackend('err');
    } catch {
      // ignore
    }
    throw new Error('Serverga ulanib bo‘lmadi. `./start-web.sh` ishlayaptimi?');
  }
  const data = await res.json().catch(() => ({}));
  if (!data || data.ok !== true) throw new Error(data?.error || 'So‘rov bajarilmadi');
  return data.result ?? data;
}

function setPill(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'warn', 'err');
  if (kind) el.classList.add(kind);
}

function setBackend(stateOrOnline, details = '') {
  let state;
  if (stateOrOnline === true) state = 'ok';
  else if (stateOrOnline === false) state = 'warn';
  else state = String(stateOrOnline || '').trim().toLowerCase();
  if (!['ok', 'warn', 'err'].includes(state)) state = 'warn';

  let label = 'Server: Ulanmoqda…';
  if (state === 'ok') label = `Server: Ishlayapti${details ? ` (${details})` : ''}`;
  else if (state === 'err') label = 'Server: Ulanmagan';

  setPill($('backendPill'), label, state);
}

function setStatus(text, kind) {
  setPill($('statusPill'), text, kind);
}

function setInventory(on) {
  setPill($('invPill'), on ? 'Skan: Faol' : 'Skan: O‘chiq', on ? 'ok' : '');
}

function firstSub(main) {
  const m = TAB_SCHEMA[main];
  if (!m) return 'basic';
  const keys = Object.keys(m.subs || {});
  return keys[0] || 'basic';
}

function normalizeView(main, sub) {
  const m = MAIN_TABS.includes(main) ? main : 'reader';
  const allowed = TAB_SCHEMA[m]?.subs || {};
  const s = Object.prototype.hasOwnProperty.call(allowed, sub) ? sub : activeSubs[m] || DEFAULT_SUBS[m] || firstSub(m);
  return { main: m, sub: s };
}

function renderSubTabs(main) {
  const el = $('subTabs');
  if (!el) return;
  const subs = TAB_SCHEMA[main]?.subs || {};
  const cur = activeSubs[main] || DEFAULT_SUBS[main] || firstSub(main);
  const parts = [];
  for (const [key, label] of Object.entries(subs)) {
    const active = key === cur ? 'active' : '';
    parts.push(`<button class="tab ${active}" type="button" data-sub="${key}">${label}</button>`);
  }
  el.innerHTML = parts.join('');
}

function parseHash() {
  const raw = String(location.hash || '').replace(/^#/, '').trim();
  if (!raw) return null;
  const [main, sub] = raw.split('/').map((s) => String(s || '').trim());
  if (!MAIN_TABS.includes(main)) return null;
  const allowed = TAB_SCHEMA[main]?.subs || {};
  if (!sub) return { main, sub: firstSub(main) };
  if (!Object.prototype.hasOwnProperty.call(allowed, sub)) return null;
  return { main, sub };
}

function setView(main, sub, { updateHash = true, save = true, scroll = true } = {}) {
  const v = normalizeView(String(main || ''), String(sub || ''));
  activeMain = v.main;
  activeSubs = { ...activeSubs, [v.main]: v.sub };

  for (const sec of document.querySelectorAll('.module[data-main][data-sub]')) {
    sec.classList.toggle('hidden', sec.dataset.main !== v.main || sec.dataset.sub !== v.sub);
  }

  const mainTabs = $('mainTabs');
  if (mainTabs) {
    for (const btn of mainTabs.querySelectorAll('[data-main]')) {
      const on = btn.dataset.main === v.main;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  renderSubTabs(v.main);

  if (updateHash) {
    const nextHash = `#${v.main}/${v.sub}`;
    try {
      if (location.hash !== nextHash) history.replaceState(null, '', nextHash);
    } catch {
      location.hash = `${v.main}/${v.sub}`;
    }
  }

  if (save) {
    try {
      saveUiState();
    } catch {
      // ignore
    }
  }

  if (scroll) {
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      window.scrollTo(0, 0);
    }
  }
}

function saveUiState() {
  const state = {
    ui: {
      main: activeMain,
      subs: activeSubs,
    },
    conn: getConnArgs(),
    inv: getInvParams(),
    invNoRepeat: $('invNoRepeat')?.checked ?? false,
    basic: getBasicParams(),
    rw: getRwParams(),
    autoConnect: $('autoConnect').checked,
    invAutoClear: $('invAutoClear')?.checked ?? true,
    invShowPhase: $('invShowPhase')?.checked ?? true,
    tagFilter: $('tagFilter')?.value ?? '',
    tagView: {
      mode: $('tagViewMode')?.value ?? 'epc',
      sort: $('tagViewSort')?.value ?? 'last',
      ant: $('tagViewAnt')?.value ?? '0',
      filter: $('tagViewFilter')?.value ?? '',
    },
    antReport: {
      ant: $('antReportAnt')?.value ?? '1',
      sort: $('antReportSort')?.value ?? 'count',
      filter: $('antReportFilter')?.value ?? '',
    },
    rwAutoStopInv: $('rwAutoStopInv')?.checked ?? true,
  };
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

function loadUiState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    const maybeMain = String(state?.ui?.main || '');
    if (MAIN_TABS.includes(maybeMain)) activeMain = maybeMain;
    if (state?.ui?.subs && typeof state.ui.subs === 'object') {
      for (const [k, v] of Object.entries(state.ui.subs)) {
        if (!MAIN_TABS.includes(k)) continue;
        const allowed = TAB_SCHEMA[k]?.subs || {};
        if (Object.prototype.hasOwnProperty.call(allowed, v)) activeSubs[k] = v;
      }
    }

    // Legacy migration (older UI stored "activeModule")
    if (state?.activeModule) {
      const legacy = String(state.activeModule);
      if (legacy === 'inventory') {
        activeMain = 'c1g2';
        activeSubs.c1g2 = 'realtime';
      } else if (legacy === 'rw') {
        activeMain = 'c1g2';
        activeSubs.c1g2 = 'rw';
      } else {
        activeMain = 'reader';
        activeSubs.reader = 'basic';
      }
    }
    if (state?.conn?.mode) $('connMode').value = String(state.conn.mode);
    if (state?.conn?.ip) $('ip').value = state.conn.ip;
    if (state?.conn?.port) $('port').value = String(state.conn.port);
    if (state?.conn?.device) $('serialDevice').value = String(state.conn.device);
    if (state?.conn?.baud !== undefined) $('serialBaud').value = String(state.conn.baud);
    if (state?.conn?.readerType) $('readerType').value = String(state.conn.readerType);
    if (state?.conn?.logSwitch !== undefined) $('logSwitch').value = String(state.conn.logSwitch);
    if (state?.inv?.qValue !== undefined) $('qValue').value = String(state.inv.qValue);
    if (state?.inv?.session !== undefined) $('session').value = String(state.inv.session);
    if (state?.inv?.scanTime !== undefined) $('scanTime').value = String(state.inv.scanTime);
    if (state?.inv?.antennaMask !== undefined) $('antennaMask').value = String(state.inv.antennaMask);
    if (state?.inv?.tidPtr !== undefined) $('tidPtr').value = String(state.inv.tidPtr);
    if (state?.inv?.tidLen !== undefined) $('tidLen').value = String(state.inv.tidLen);
    if (state?.inv?.memory !== undefined && $('invMem')) $('invMem').value = String(state.inv.memory);
    if (state?.inv?.invPwd !== undefined && $('invPwd')) $('invPwd').value = String(state.inv.invPwd);
    if (state?.inv?.target !== undefined && $('invTarget')) $('invTarget').value = String(state.inv.target);
    if (state?.inv?.retryCount !== undefined && $('invRetryCount')) $('invRetryCount').value = String(state.inv.retryCount);
    if (state?.inv?.ivtType !== undefined) {
      for (const el of document.querySelectorAll('input[name="invType"]')) {
        el.checked = Number(el.value) === Number(state.inv.ivtType);
      }
    }
    $('autoConnect').checked = Boolean(state?.autoConnect);
    if (state?.invAutoClear !== undefined && $('invAutoClear')) $('invAutoClear').checked = Boolean(state.invAutoClear);
    if (state?.invShowPhase !== undefined && $('invShowPhase')) $('invShowPhase').checked = Boolean(state.invShowPhase);
    if (state?.invNoRepeat !== undefined && $('invNoRepeat')) $('invNoRepeat').checked = Boolean(state.invNoRepeat);
    if (state?.tagFilter !== undefined && $('tagFilter')) $('tagFilter').value = String(state.tagFilter || '');
    if (state?.tagView && typeof state.tagView === 'object') {
      if (state.tagView.mode !== undefined && $('tagViewMode')) $('tagViewMode').value = String(state.tagView.mode || 'epc');
      if (state.tagView.sort !== undefined && $('tagViewSort')) $('tagViewSort').value = String(state.tagView.sort || 'last');
      if (state.tagView.ant !== undefined && $('tagViewAnt')) $('tagViewAnt').value = String(state.tagView.ant || '0');
      if (state.tagView.filter !== undefined && $('tagViewFilter')) $('tagViewFilter').value = String(state.tagView.filter || '');
    }
    if (state?.antReport && typeof state.antReport === 'object') {
      if (state.antReport.ant !== undefined && $('antReportAnt')) $('antReportAnt').value = String(state.antReport.ant || '1');
      if (state.antReport.sort !== undefined && $('antReportSort')) $('antReportSort').value = String(state.antReport.sort || 'count');
      if (state.antReport.filter !== undefined && $('antReportFilter')) $('antReportFilter').value = String(state.antReport.filter || '');
    }
    if (state?.rw?.mem !== undefined) $('rwMem').value = String(state.rw.mem);
    if (state?.rw?.wordPtr !== undefined) $('rwWordPtr').value = String(state.rw.wordPtr);
    if (state?.rw?.num !== undefined) $('rwNum').value = String(state.rw.num);
    if (state?.rw?.password !== undefined) $('rwPwd').value = String(state.rw.password);
    if (state?.rwAutoStopInv !== undefined) $('rwAutoStopInv').checked = Boolean(state.rwAutoStopInv);
    pendingBasicState = state?.basic && typeof state.basic === 'object' ? state.basic : null;
  } catch {
    // ignore
  }
}

const tags = new Map();
let totalReads = 0;
let backendToastAt = 0;
let backendConnected = false;
let backendErrTimer = 0;
let selectedEpc = '';
let invStartedAt = 0;
let speedMarks = [];
let tagViewRenderTimer = 0;
let invOnceWaiter = null;

let currentStatus = {
  connected: false,
  inventoryStarted: false,
  lastConnectArgs: null,
};

function setLocked(btn, locked) {
  if (!btn) return;
  btn.dataset.locked = locked ? '1' : '0';
  const busy = btn.dataset.busy === '1';
  btn.disabled = locked || busy;
}

function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.dataset.prevText = btn.textContent;
    btn.textContent = label || 'Bajarilmoqda…';
    btn.classList.add('busy');
  } else {
    btn.dataset.busy = '0';
    if (btn.dataset.prevText) btn.textContent = btn.dataset.prevText;
    btn.classList.remove('busy');
  }
  const locked = btn.dataset.locked === '1';
  btn.disabled = locked || busy;
}

async function runBusy(btn, label, fn) {
  if (!btn) return;
  if (btn.dataset.busy === '1') return;
  setBusy(btn, true, label);
  try {
    return await fn();
  } finally {
    setBusy(btn, false);
    applyStatus(currentStatus);
  }
}

function renderTags() {
  const tbody = $('tagTable');
  const filter = String($('tagFilter')?.value || '')
    .trim()
    .toUpperCase();
  const want = filter ? filter.replace(/[^0-9A-F]/g, '') : '';

  const rows = [...tags.values()]
    .filter((t) => {
      if (!want) return true;
      const epc = String(t.epcId || '').toUpperCase();
      const mem = String(t.memId || '').toUpperCase();
      return epc.includes(want) || mem.includes(want);
    })
    // Stable order (Windows demo kabi): birinchi ko‘ringan tartibda turadi.
    .sort((a, b) => (a.firstSeen ?? a.lastSeen ?? 0) - (b.firstSeen ?? b.lastSeen ?? 0));

  const showPhase = Boolean($('invShowPhase')?.checked);
  const table = $('tagTableTable');
  if (table) table.classList.toggle('show-phase', showPhase);

  const formatAntList = (antCounts, fallback = '-') => {
    try {
      if (!antCounts || typeof antCounts !== 'object') return fallback;
      const ants = Object.keys(antCounts)
        .map((k) => Number(k))
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b);
      if (!ants.length) return fallback;
      return ants.join(',');
    } catch {
      return fallback;
    }
  };

  tbody.innerHTML = rows
    .map((t, idx) => {
      const fresh = Date.now() - t.lastSeen < 1200 ? 'fresh' : '';
      const selected = t.epcId === selectedEpc ? 'selected' : '';
      const cls = `${fresh} ${selected}`.trim();
      const mem = t.memId ? String(t.memId) : '-';
      const pb = Number.isFinite(t.phaseBegin) ? String(t.phaseBegin) : '-';
      const pe = Number.isFinite(t.phaseEnd) ? String(t.phaseEnd) : '-';
      const fq = Number.isFinite(t.freqKhz) ? String(t.freqKhz) : '-';
      const antLabel = formatAntList(t.antCounts, String(t.antId ?? '-'));
      return `<tr class="${cls}" data-epc="${String(t.epcId || '')}">
        <td>${idx + 1}</td>
        <td class="col-epc">${t.epcId}</td>
        <td>${mem}</td>
        <td>${t.count}</td>
        <td>${t.rssi}</td>
        <td class="col-phase">${pb}</td>
        <td class="col-phase">${pe}</td>
        <td>${antLabel}</td>
        <td class="col-phase">${fq}</td>
        <td>${new Date(t.lastSeen).toLocaleTimeString()}</td>
      </tr>`;
    })
    .join('');

  // click-to-fill EPC for read/write
  for (const tr of tbody.querySelectorAll('tr')) {
    tr.addEventListener('click', () => {
      const epc = String(tr.dataset.epc || '').trim();
      selectedEpc = epc;
      $('rwEpc').value = epc;
      updateRwMeta();
      renderTags();
      setView('c1g2', 'rw');
      toast('EPC tanlandi (R/W uchun).', 'ok');
      try {
        $('rwEpc').focus();
      } catch {
        // ignore
      }
    });
  }
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (!/[\",\n\r]/.test(s)) return s;
  return `"${s.replaceAll('"', '""')}"`;
}

function buildTagsCsv() {
  const rows = [...tags.values()].sort((a, b) => b.count - a.count);
  const lines = [];
  lines.push(['EPC', 'MEM', 'Count', 'RSSI', 'Phase_begin', 'Phase_end', 'ANT', 'FreqKhz', 'LastSeen'].join(','));
  for (const t of rows) {
    const antLabel = (() => {
      try {
        const ants = Object.keys(t.antCounts || {})
          .map((k) => Number(k))
          .filter((n) => Number.isInteger(n) && n > 0)
          .sort((a, b) => a - b);
        if (ants.length) return ants.join(',');
      } catch {
        // ignore
      }
      return String(t.antId ?? '');
    })();
    lines.push(
      [
        csvEscape(t.epcId),
        csvEscape(t.memId ?? ''),
        csvEscape(t.count),
        csvEscape(t.rssi),
        csvEscape(t.phaseBegin ?? ''),
        csvEscape(t.phaseEnd ?? ''),
        csvEscape(antLabel),
        csvEscape(t.freqKhz ?? ''),
        csvEscape(new Date(t.lastSeen).toISOString()),
      ].join(','),
    );
  }
  return lines.join('\n');
}

function getTagViewParams() {
  const mode = String($('tagViewMode')?.value || 'epc').trim();
  const sort = String($('tagViewSort')?.value || 'last').trim();
  const antRaw = Number($('tagViewAnt')?.value ?? 0);
  const ant = Number.isFinite(antRaw) ? Math.max(0, Math.min(31, Math.trunc(antRaw))) : 0;
  const filter = compactHex($('tagViewFilter')?.value);
  return { mode: mode === 'epc_ant' ? 'epc_ant' : 'epc', sort, ant, filter };
}

function getAntennaCountFromUi() {
  const raw = Number($('readerType')?.value ?? 16);
  const n = Number.isFinite(raw) ? Math.trunc(raw) : 16;
  return Math.max(1, Math.min(31, n));
}

function populateTagViewAntOptions({ keep = true } = {}) {
  const sel = $('tagViewAnt');
  if (!sel) return;
  const prev = keep ? String(sel.value || '0') : '0';
  const count = getAntennaCountFromUi();
  const parts = ['<option value="0">Barchasi</option>'];
  for (let i = 1; i <= count; i += 1) parts.push(`<option value="${i}">ANT${i}</option>`);
  sel.innerHTML = parts.join('');
  const wanted = Number(prev);
  if (Number.isInteger(wanted) && wanted >= 0 && wanted <= count) sel.value = String(wanted);
  else sel.value = '0';
}

function formatAntCounts(antCounts, { withCounts = true } = {}) {
  if (!antCounts || typeof antCounts !== 'object') return '';
  const entries = Object.entries(antCounts)
    .map(([k, v]) => [Number(k), Number(v)])
    .filter(([ant, cnt]) => Number.isInteger(ant) && ant > 0 && Number.isFinite(cnt) && cnt > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!entries.length) return '';
  if (!withCounts) return entries.map(([ant]) => `ANT${ant}`).join(', ');
  return entries.map(([ant, cnt]) => `ANT${ant}:${cnt}`).join(', ');
}

function scheduleTagViewRender() {
  if (tagViewRenderTimer) return;
  tagViewRenderTimer = window.setTimeout(() => {
    tagViewRenderTimer = 0;
    try {
      renderTagView();
    } catch {
      // ignore
    }
    try {
      renderAntReport();
    } catch {
      // ignore
    }
  }, 120);
}

function renderAntennaStats() {
  const grid = $('antStatsGrid');
  if (!grid) return;
  const { ant: selectedAnt } = getTagViewParams();
  const count = getAntennaCountFromUi();

  const parts = [];
  for (let ant = 1; ant <= count; ant += 1) {
    let reads = 0;
    let unique = 0;
    for (const t of tags.values()) {
      const c = Number(t.antCounts?.[String(ant)] ?? 0);
      if (Number.isFinite(c) && c > 0) {
        reads += c;
        unique += 1;
      }
    }
    const selected = selectedAnt === ant ? 'selected' : '';
    parts.push(`
      <div class="digit-card selectable ${selected}" data-ant="${ant}">
        <div class="digit-label">ANT${ant}</div>
        <div class="digit small">Unique: ${unique} · Reads: ${reads}</div>
      </div>
    `);
  }

  grid.innerHTML = parts.join('');

  for (const el of grid.querySelectorAll('.digit-card.selectable')) {
    el.addEventListener('click', () => {
      const ant = Number(el.dataset.ant || 0);
      if (!Number.isInteger(ant) || ant <= 0) return;
      const sel = $('tagViewAnt');
      if (sel) sel.value = String(ant);
      try {
        saveUiState();
      } catch {
        // ignore
      }
      renderTagView();
    });
  }
}

function buildTagViewRows({ mode, ant, filter, sort }) {
  const want = filter ? filter.replace(/[^0-9A-F]/g, '') : '';

  if (mode === 'epc_ant') {
    const rows = [];
    for (const t of tags.values()) {
      if (want) {
        const epc = String(t.epcId || '').toUpperCase();
        const mem = String(t.memId || '').toUpperCase();
        if (!epc.includes(want) && !mem.includes(want)) continue;
      }
      const entries = Object.entries(t.antCounts || {})
        .map(([k, v]) => [Number(k), Number(v)])
        .filter(([a, c]) => Number.isInteger(a) && a > 0 && Number.isFinite(c) && c > 0);
      for (const [a, c] of entries) {
        if (ant && a !== ant) continue;
        rows.push({
          epcId: t.epcId,
          memId: t.memId ?? '',
          count: c,
          rssi: t.rssi,
          antLabel: `ANT${a}`,
          lastSeen: t.lastSeen,
        });
      }
    }
    const sorted = rows.sort((a, b) => {
      if (sort === 'count') return b.count - a.count;
      if (sort === 'epc') return String(a.epcId).localeCompare(String(b.epcId));
      return b.lastSeen - a.lastSeen;
    });
    return sorted;
  }

  const rows = [...tags.values()]
    .filter((t) => {
      if (want) {
        const epc = String(t.epcId || '').toUpperCase();
        const mem = String(t.memId || '').toUpperCase();
        if (!epc.includes(want) && !mem.includes(want)) return false;
      }
      if (!ant) return true;
      const c = Number(t.antCounts?.[String(ant)] ?? 0);
      return Number.isFinite(c) && c > 0;
    })
    .map((t) => ({
      epcId: t.epcId,
      memId: t.memId ?? '',
      count: t.count,
      rssi: t.rssi,
      antLabel: formatAntCounts(t.antCounts, { withCounts: true }) || String(t.antId ?? ''),
      lastSeen: t.lastSeen,
    }));

  const sorted = rows.sort((a, b) => {
    if (sort === 'count') return b.count - a.count;
    if (sort === 'epc') return String(a.epcId).localeCompare(String(b.epcId));
    return b.lastSeen - a.lastSeen;
  });
  return sorted;
}

function buildTagViewCsv() {
  const params = getTagViewParams();
  const rows = buildTagViewRows(params);
  const lines = [];
  lines.push(['EPC', 'MEM', 'Count', 'RSSI', 'ANT', 'LastSeen'].join(','));
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.epcId),
        csvEscape(r.memId ?? ''),
        csvEscape(r.count),
        csvEscape(r.rssi ?? ''),
        csvEscape(r.antLabel ?? ''),
        csvEscape(new Date(r.lastSeen).toISOString()),
      ].join(','),
    );
  }
  return lines.join('\n');
}

function renderTagView() {
  const tbody = $('tagViewBody');
  const hintEl = $('tagViewHint');
  if (!tbody) return;

  populateTagViewAntOptions({ keep: true });

  const params = getTagViewParams();
  const rows = buildTagViewRows(params);
  const uniqueCount = tags.size;
  const shown = rows.length;

  if (hintEl) {
    const parts = [];
    parts.push(`Unique taglar: ${uniqueCount}`);
    parts.push(`Ko‘rsatilmoqda: ${shown}`);
    parts.push(`Ko‘rinish: ${params.mode === 'epc_ant' ? 'EPC+ANT' : 'EPC (bitta tag)'}`);
    hintEl.textContent = parts.join(' · ');
  }

  tbody.innerHTML = rows
    .slice(0, 500)
    .map((r, idx) => {
      return `<tr data-epc="${String(r.epcId || '')}">
        <td>${idx + 1}</td>
        <td class="col-epc">${String(r.epcId || '')}</td>
        <td>${r.memId ? String(r.memId) : '-'}</td>
        <td>${r.count}</td>
        <td>${r.rssi ?? ''}</td>
        <td>${r.antLabel ? String(r.antLabel) : '-'}</td>
        <td>${new Date(r.lastSeen).toLocaleTimeString()}</td>
      </tr>`;
    })
    .join('');

  for (const tr of tbody.querySelectorAll('tr')) {
    tr.addEventListener('click', () => {
      const epc = String(tr.dataset.epc || '').trim();
      if (!epc) return;
      selectedEpc = epc;
      if ($('rwEpc')) $('rwEpc').value = epc;
      updateRwMeta();
      renderTags();
      setView('c1g2', 'rw');
      toast('EPC tanlandi (R/W uchun).', 'ok');
    });
  }

  renderAntennaStats();
}

function getAntReportParams() {
  const antRaw = Number($('antReportAnt')?.value ?? 1);
  const ant = Number.isFinite(antRaw) ? Math.max(1, Math.min(31, Math.trunc(antRaw))) : 1;
  const sort = String($('antReportSort')?.value || 'count').trim();
  const filter = compactHex($('antReportFilter')?.value);
  return { ant, sort, filter };
}

function populateAntReportAntOptions({ keep = true } = {}) {
  const sel = $('antReportAnt');
  if (!sel) return;
  const prev = keep ? String(sel.value || '1') : '1';
  const count = getAntennaCountFromUi();
  const parts = [];
  for (let i = 1; i <= count; i += 1) parts.push(`<option value="${i}">ANT${i}</option>`);
  sel.innerHTML = parts.join('');
  const wanted = Number(prev);
  if (Number.isInteger(wanted) && wanted >= 1 && wanted <= count) sel.value = String(wanted);
  else sel.value = '1';
}

function buildAntSummaryRows() {
  const count = getAntennaCountFromUi();
  const rows = [];
  for (let ant = 1; ant <= count; ant += 1) {
    let reads = 0;
    let unique = 0;
    for (const t of tags.values()) {
      const c = Number(t.antCounts?.[String(ant)] ?? 0);
      if (Number.isFinite(c) && c > 0) {
        reads += c;
        unique += 1;
      }
    }
    rows.push({ ant, unique, reads });
  }
  return rows;
}

function buildAntDetailRows({ ant, filter, sort }) {
  const want = filter ? filter.replace(/[^0-9A-F]/g, '') : '';
  const antKey = String(ant);
  const rows = [];
  for (const t of tags.values()) {
    const c = Number(t.antCounts?.[antKey] ?? 0);
    if (!Number.isFinite(c) || c <= 0) continue;
    if (want) {
      const epc = String(t.epcId || '').toUpperCase();
      const mem = String(t.memId || '').toUpperCase();
      if (!epc.includes(want) && !mem.includes(want)) continue;
    }
    rows.push({
      epcId: t.epcId,
      memId: t.memId ?? '',
      count: c,
      rssi: t.rssi,
      lastSeen: t.lastSeen,
    });
  }

  rows.sort((a, b) => {
    if (sort === 'epc') return String(a.epcId).localeCompare(String(b.epcId));
    if (sort === 'last') return b.lastSeen - a.lastSeen;
    return b.count - a.count;
  });

  return rows;
}

function buildAntReportCsv() {
  const params = getAntReportParams();
  const rows = buildAntDetailRows(params);
  const lines = [];
  lines.push(['ANT', 'EPC', 'MEM', 'Count', 'RSSI', 'LastSeen'].join(','));
  for (const r of rows) {
    lines.push(
      [
        csvEscape(`ANT${params.ant}`),
        csvEscape(r.epcId),
        csvEscape(r.memId ?? ''),
        csvEscape(r.count),
        csvEscape(r.rssi ?? ''),
        csvEscape(new Date(r.lastSeen).toISOString()),
      ].join(','),
    );
  }
  return lines.join('\n');
}

function renderAntReport() {
  const summaryBody = $('antSummaryBody');
  const detailBody = $('antDetailBody');
  if (!summaryBody || !detailBody) return;

  populateAntReportAntOptions({ keep: true });
  const params = getAntReportParams();

  const summary = buildAntSummaryRows();
  summaryBody.innerHTML = summary
    .map((r, idx) => {
      const selected = r.ant === params.ant ? 'selected' : '';
      return `<tr class="${selected}" data-ant="${r.ant}">
        <td>${idx + 1}</td>
        <td>ANT${r.ant}</td>
        <td>${r.unique}</td>
        <td>${r.reads}</td>
      </tr>`;
    })
    .join('');

  for (const tr of summaryBody.querySelectorAll('tr')) {
    tr.addEventListener('click', () => {
      const ant = Number(tr.dataset.ant || 0);
      if (!Number.isInteger(ant) || ant <= 0) return;
      if ($('antReportAnt')) $('antReportAnt').value = String(ant);
      try {
        saveUiState();
      } catch {
        // ignore
      }
      renderAntReport();
    });
  }

  const detailRows = buildAntDetailRows(params);

  const titleEl = $('antDetailTitle');
  if (titleEl) titleEl.textContent = `ANT${params.ant} — taglar`;

  const hintEl = $('antReportHint');
  if (hintEl) {
    const sum = summary.find((x) => x.ant === params.ant) || { unique: 0, reads: 0 };
    hintEl.textContent = `ANT${params.ant}: Unique=${sum.unique} · O‘qishlar=${sum.reads} · Ko‘rsatilmoqda=${detailRows.length}`;
  }

  detailBody.innerHTML = detailRows
    .slice(0, 800)
    .map((r, idx) => {
      return `<tr data-epc="${String(r.epcId || '')}">
        <td>${idx + 1}</td>
        <td class="col-epc">${String(r.epcId || '')}</td>
        <td>${r.memId ? String(r.memId) : '-'}</td>
        <td>${r.count}</td>
        <td>${r.rssi ?? ''}</td>
        <td>${new Date(r.lastSeen).toLocaleTimeString()}</td>
      </tr>`;
    })
    .join('');

  for (const tr of detailBody.querySelectorAll('tr')) {
    tr.addEventListener('click', () => {
      const epc = String(tr.dataset.epc || '').trim();
      if (!epc) return;
      selectedEpc = epc;
      if ($('rwEpc')) $('rwEpc').value = epc;
      updateRwMeta();
      renderTags();
      setView('c1g2', 'rw');
      toast('EPC tanlandi (R/W uchun).', 'ok');
    });
  }
}

function cancelInvOnce(reason = 'Canceled') {
  if (!invOnceWaiter) return;
  try {
    window.clearTimeout(invOnceWaiter.timer);
  } catch {
    // ignore
  }
  try {
    invOnceWaiter.reject(new Error(String(reason || 'Canceled')));
  } catch {
    // ignore
  }
  invOnceWaiter = null;
}

function waitForInvOnceTag({ timeoutMs = 8000 } = {}) {
  cancelInvOnce('Replaced');
  const t = Number(timeoutMs);
  const ms = Number.isFinite(t) ? Math.max(500, Math.min(60_000, Math.trunc(t))) : 8000;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (!invOnceWaiter) return;
      invOnceWaiter = null;
      reject(new Error('Tag topilmadi (timeout).'));
    }, ms);
    invOnceWaiter = { resolve, reject, timer, done: false };
  });
}

function upsertTag(tag) {
  const k = compactHex(tag.epcId || '');
  if (!k) return;

  // One-shot (bir marta o‘qish): birinchi kelgan tagni ushlaymiz.
  try {
    if (invOnceWaiter && invOnceWaiter.done !== true) {
      invOnceWaiter.done = true;
      window.clearTimeout(invOnceWaiter.timer);
      const resolve = invOnceWaiter.resolve;
      invOnceWaiter = null;
      resolve({ epc: k, tag });
    }
  } catch {
    // ignore
  }

  const noRepeat = Boolean($('invNoRepeat')?.checked);
  const now = Date.now();
  const ant = Number(tag.antId);
  const antKey = Number.isInteger(ant) && ant > 0 ? String(ant) : '';

  const prev = tags.get(k);
  const isNewEpc = !prev;

  if (!prev) {
    totalReads += 1;
    const antCounts = {};
    if (antKey) antCounts[antKey] = 1;
    tags.set(k, {
      ...tag,
      epcId: k,
      memId: compactHex(tag.memId || ''),
      count: 1,
      lastSeen: now,
      firstSeen: now,
      antCounts,
    });
  } else {
    const antCounts = prev.antCounts && typeof prev.antCounts === 'object' ? { ...prev.antCounts } : {};
    if (antKey) {
      if (noRepeat) {
        if (antCounts[antKey] === undefined) antCounts[antKey] = 1;
      } else {
        antCounts[antKey] = Number(antCounts[antKey] || 0) + 1;
      }
    }

    const next = {
      ...prev,
      memId: tag.memId !== undefined ? compactHex(tag.memId || '') : prev.memId,
      rssi: tag.rssi ?? prev.rssi,
      phaseBegin: tag.phaseBegin ?? prev.phaseBegin,
      phaseEnd: tag.phaseEnd ?? prev.phaseEnd,
      freqKhz: tag.freqKhz ?? prev.freqKhz,
      antId: tag.antId ?? prev.antId,
      lastSeen: now,
      antCounts,
    };

    if (!noRepeat) {
      totalReads += 1;
      next.count = Number(prev.count || 0) + 1;
    }

    tags.set(k, next);
  }

  renderTags();
  scheduleTagViewRender();

  setText('statUnique', String(tags.size));
  setText('statTotal', String(totalReads));
  setText('statLast', String(k || '-'));

  if (currentStatus.inventoryStarted) {
    if (!noRepeat || isNewEpc) {
      speedMarks.push(now);
      if (speedMarks.length > 5000) speedMarks = speedMarks.slice(-2500);
    }
  }
}

function getConnArgs() {
  const mode = String($('connMode')?.value || 'tcp').trim().toLowerCase();
  const baudRaw = Number($('serialBaud')?.value);
  const baud = Number.isFinite(baudRaw) ? baudRaw : 0;
  return {
    mode: mode === 'serial' ? 'serial' : 'tcp',
    ip: $('ip').value.trim(),
    port: Number($('port').value),
    device: String($('serialDevice')?.value || '').trim(),
    baud,
    readerType: Number($('readerType').value),
    logSwitch: Number($('logSwitch').value),
  };
}

function getInvParams() {
  const itEl = document.querySelector('input[name="invType"]:checked');
  const ivtTypeRaw = Number(itEl?.value ?? 0);
  const ivtType = Number.isFinite(ivtTypeRaw) ? ivtTypeRaw : 0;

  const invPwdRaw = compactHex($('invPwd')?.value);
  const invPwd = invPwdRaw ? invPwdRaw.slice(0, 8).padStart(8, '0') : '00000000';

  return {
    ivtType,
    memory: Number($('invMem')?.value ?? 1),
    invPwd,
    qValue: Number($('qValue').value),
    session: Number($('session').value),
    scanTime: Number($('scanTime').value),
    antennaMask: Number($('antennaMask').value),
    tidPtr: Number($('tidPtr').value),
    tidLen: Number($('tidLen').value),
    target: Number($('invTarget')?.value ?? 0),
    retryCount: Number($('invRetryCount')?.value ?? 0),
  };
}

function validateInvParams(p) {
  const fail = (id, msg) => {
    flashField(id);
    throw new Error(msg);
  };

  const ivtType = Number(p.ivtType);
  if (![0, 1, 2].includes(ivtType)) fail('invTypeRadios', 'Answer mode (o‘qish turi) noto‘g‘ri.');

  const qValue = Number(p.qValue);
  if (!Number.isInteger(qValue) || qValue < 0 || qValue > 15) fail('qValue', 'Q qiymati 0..15 oralig‘ida bo‘lsin.');

  const session = Number(p.session);
  const allowedSessions = new Set([0, 1, 2, 3, 253, 254, 255]);
  if (!allowedSessions.has(session)) fail('session', 'Session 0..3 yoki AUTO (253-255) bo‘lsin.');

  const scanTime = Number(p.scanTime);
  if (!Number.isInteger(scanTime) || scanTime < 1 || scanTime > 255) {
    fail('scanTime', 'Skan vaqti (x100ms) 1..255 oralig‘ida bo‘lsin.');
  }

  const target = Number(p.target);
  if (![0, 1].includes(target)) fail('invTarget', 'Target faqat A yoki B bo‘lishi kerak.');

  const retryCount = Number(p.retryCount);
  if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 255) {
    fail('invRetryCount', '“No tag” count 0..255 oralig‘ida bo‘lsin.');
  }

  const tidPtr = Number(p.tidPtr);
  if (!Number.isInteger(tidPtr) || tidPtr < 0 || tidPtr > 255) fail('tidPtr', 'Addr (word ptr) 0..255 bo‘lsin.');

  const tidLen = Number(p.tidLen);
  if (!Number.isInteger(tidLen) || tidLen < 0 || tidLen > 255) fail('tidLen', 'Len (word) 0..255 bo‘lsin.');

  const antennaMask = Number(p.antennaMask);
  if (!Number.isInteger(antennaMask) || antennaMask <= 0) {
    fail('antennaMask', 'Antenna maskasi 0. Kamida bitta antennani tanlang (ANT1/ANT2/...).');
  }

  const memory = Number(p.memory);
  if (![1, 2, 3].includes(memory)) fail('invMem', 'Mix: Mem faqat EPC/TID/User bo‘lishi kerak.');

  const invPwd = String(p.invPwd || '');
  if (!isHexStrict(invPwd) || invPwd.length !== 8) {
    fail('invPwd', 'Mix: Password (8 hex) noto‘g‘ri. Masalan: 00000000');
  }

  // Best-effort warning: mask UI count vs bits
  try {
    const antCount = Number($('readerType')?.value ?? 16);
    if (Number.isInteger(antCount) && antCount > 0 && antCount <= 30) {
      const maxMask = (1 << antCount) - 1;
      if ((antennaMask & ~maxMask) !== 0) {
        toast(`Ogohlantirish: antenna maskasi ${antCount} portdan tashqariga chiqyapti.`, 'warn', { ttlMs: 6500 });
        logLine(`Ogohlantirish: antennaMask=${antennaMask} (UI=${antCount} antenna).`);
      }
    }
  } catch {
    // ignore
  }
}

function clampIntField(id, { min, max, fallback, quiet = false } = {}) {
  const el = $(id);
  if (!el) return;
  const raw = Number(el.value);
  if (!Number.isFinite(raw)) {
    el.value = String(fallback ?? min ?? 0);
    if (!quiet) toast(`${id}: qiymat noto‘g‘ri, default qo‘yildi.`, 'warn', { ttlMs: 4500 });
    return;
  }
  const v = Math.trunc(raw);
  const lo = Number.isFinite(min) ? min : v;
  const hi = Number.isFinite(max) ? max : v;
  const next = Math.min(hi, Math.max(lo, v));
  if (next !== v) {
    el.value = String(next);
    if (!quiet) toast(`Skan vaqti (x100ms) ${lo}..${hi} oralig‘ida bo‘lishi kerak.`, 'warn', { ttlMs: 6500 });
  }
}

function getSelectedBand() {
  const el = document.querySelector('input[name="bandRadio"]:checked');
  const v = Number(el?.value);
  return Number.isFinite(v) ? v : 2;
}

function setSelectedBand(band) {
  const b = Number(band);
  for (const el of document.querySelectorAll('input[name="bandRadio"]')) {
    el.checked = Number(el.value) === b;
  }
}

function getBasicParams() {
  const minRaw = Number($('minfre')?.value);
  const maxRaw = Number($('maxfre')?.value);
  return {
    power: Number($('power')?.value ?? 30),
    beepEnabled: Number($('beepEnabled')?.value ?? 1),
    drmEnabled: Number($('drmEnabled')?.value ?? 0),
    band: getSelectedBand(),
    minfre: Number.isFinite(minRaw) ? minRaw : 0,
    maxfre: Number.isFinite(maxRaw) ? maxRaw : 0,
    sameFre: $('sameFre')?.checked ?? false,
    retryTimes: Number($('retryTimes')?.value ?? 3),
    checkAntEnabled: Number($('checkAntEnabled')?.value ?? 1),
    relayValue: Number($('relayValue')?.value ?? 0),
    gpioValue: Number($('gpioValue')?.value ?? 0),
  };
}

function updateBeepToggleUi() {
  const btn = $('btnBeepToggle');
  const sel = $('beepEnabled');
  if (!btn || !sel) return;
  if (btn.dataset.busy === '1') return;

  const enabled = Number(sel.value ?? 1) !== 0;
  btn.textContent = enabled ? 'Tovush: o‘chirish' : 'Tovush: yoqish';
  btn.title = enabled ? 'Qurilmadagi beep ovozini o‘chiradi (mute).' : 'Qurilmadagi beep ovozini yoqadi.';
}

function updateConnUi() {
  const mode = String($('connMode')?.value || 'tcp')
    .trim()
    .toLowerCase();

  for (const el of document.querySelectorAll('.conn-only-tcp')) el.classList.toggle('hidden', mode !== 'tcp');
  for (const el of document.querySelectorAll('.conn-only-serial')) el.classList.toggle('hidden', mode !== 'serial');

  const btnScan = $('btnScan');
  if (btnScan) btnScan.textContent = mode === 'serial' ? 'USB qurilmalarni qidirish' : 'Tarmoqni skan qilish';
}

async function refreshSerialList({ quiet = false } = {}) {
  const dl = $('serialDeviceList');
  if (dl) dl.innerHTML = '';

  let data;
  try {
    const res = await fetch('/api/serial/list');
    data = await res.json();
  } catch (e) {
    if (!quiet) toast('Serial ro‘yxatini olish uchun serverga ulanib bo‘lmadi.', 'err', { ttlMs: 6500 });
    logLine('Serial ro‘yxati: serverga ulanib bo‘lmadi.');
    return;
  }

  if (!data?.ok) {
    const msg = String(data?.error || 'Serial ro‘yxatini olish muvaffaqiyatsiz');
    if (!quiet) toast(msg, 'err', { ttlMs: 6500 });
    logLine(`Serial ro‘yxati xatosi: ${msg}`);
    return;
  }

  const platform = String(data?.result?.platform || '').trim().toLowerCase();
  if ($('serialDevice')) $('serialDevice').placeholder = platform === 'win32' ? 'COM3' : '/dev/ttyUSB0';

  const list = data?.result?.devices || [];
  if (dl) {
    for (const d of list) {
      const opt = document.createElement('option');
      opt.value = d.path;
      if (d.name) opt.label = String(d.name);
      dl.appendChild(opt);
    }
  }

  if (!list.length) {
    const hint =
      platform === 'win32'
        ? 'USB/Serial qurilma topilmadi (COM port yo‘q). Windows Device Manager’da COM port borligini tekshiring.'
        : 'USB/Serial qurilma topilmadi ( /dev/ttyUSB*, /dev/ttyACM* ).';
    if (!quiet) toast(hint, 'warn', { ttlMs: 7000 });
    logLine('USB/Serial qurilma topilmadi.');
    return;
  }

  if (!$('serialDevice').value.trim()) $('serialDevice').value = list[0].path;
  if (!quiet) toast(`Topildi: ${list.length} ta USB/Serial port.`, 'ok');
  logLine(`USB/Serial portlar: ${list.map((d) => d.path).join(', ')}`);
}

function setBasicOut(value) {
  const el = $('basicOut');
  if (!el) return;
  if (value == null) {
    el.textContent = '';
    return;
  }
  if (typeof value === 'string') el.textContent = value;
  else el.textContent = JSON.stringify(value, null, 2);
}

function formatMhz(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(3).replace(/\.?0+$/, '');
}

function bandFreqTable(band) {
  const b = Number(band);
  const out = [];
  const add = (count, start, step) => {
    for (let i = 0; i < count; i++) out.push({ idx: i, mhz: start + i * step });
  };
  if (b === 1) add(20, 920.125, 0.25);
  else if (b === 2) add(50, 902.75, 0.5);
  else if (b === 3) add(32, 917.1, 0.2);
  else if (b === 4) add(15, 865.1, 0.2);
  else if (b === 8) add(20, 840.125, 0.25);
  else if (b === 12) add(53, 902, 0.5);
  else if (b === 0) add(61, 840, 2);
  else add(50, 902.75, 0.5);
  return out;
}

function guessReturnLossFreqKhz() {
  try {
    const band = getSelectedBand();
    const list = bandFreqTable(band);
    if (!list.length) return 902750;

    const clampIdx = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return NaN;
      const i = Math.trunc(n);
      return Math.max(0, Math.min(list.length - 1, i));
    };

    const minIdx = clampIdx($('minfre')?.value);
    const maxIdx = clampIdx($('maxfre')?.value);
    let idx = Math.trunc(list.length / 2);
    if (Number.isFinite(minIdx) && Number.isFinite(maxIdx)) idx = Math.trunc((minIdx + maxIdx) / 2);

    const mhz = Number(list[idx]?.mhz);
    const khz = Math.round(mhz * 1000);
    return Number.isFinite(khz) && khz > 0 ? khz : 902750;
  } catch {
    return 902750;
  }
}

function populateFreqSelects(band, { keepSelection = true } = {}) {
  const minEl = $('minfre');
  const maxEl = $('maxfre');
  if (!minEl || !maxEl) return;

  const prevMin = keepSelection ? Number(minEl.value) : NaN;
  const prevMax = keepSelection ? Number(maxEl.value) : NaN;

  const list = bandFreqTable(band);
  minEl.innerHTML = '';
  maxEl.innerHTML = '';

  for (const it of list) {
    const label = `${it.idx}: ${formatMhz(it.mhz)} MHz`;
    const optMin = document.createElement('option');
    optMin.value = String(it.idx);
    optMin.textContent = label;
    minEl.appendChild(optMin);
    const optMax = document.createElement('option');
    optMax.value = String(it.idx);
    optMax.textContent = label;
    maxEl.appendChild(optMax);
  }

  const maxDefault = Math.max(0, list.length - 1);
  minEl.value = Number.isFinite(prevMin) ? String(prevMin) : '0';
  if (!minEl.value) minEl.value = '0';
  maxEl.value = Number.isFinite(prevMax) ? String(prevMax) : String(maxDefault);
  if (!maxEl.value) maxEl.value = String(maxDefault);

  syncRegionConstraints();
}

function syncRegionConstraints({ source = '' } = {}) {
  const minEl = $('minfre');
  const maxEl = $('maxfre');
  const same = Boolean($('sameFre')?.checked);
  if (!minEl || !maxEl) return;

  if (same) {
    maxEl.value = minEl.value;
    maxEl.disabled = true;
    return;
  }

  maxEl.disabled = false;

  const minIdx = Number(minEl.value);
  const maxIdx = Number(maxEl.value);
  if (!Number.isFinite(minIdx) || !Number.isFinite(maxIdx)) return;
  if (minIdx <= maxIdx) return;

  if (source === 'max') minEl.value = maxEl.value;
  else maxEl.value = minEl.value;
}

function initRegionUi() {
  populateFreqSelects(getSelectedBand(), { keepSelection: true });
  syncRegionConstraints();
}

function applyBasicState(state) {
  if (!state || typeof state !== 'object') return;

  if (state.power !== undefined && $('power')) $('power').value = String(state.power);
  if (state.beepEnabled !== undefined && $('beepEnabled')) $('beepEnabled').value = String(state.beepEnabled);
  if (state.drmEnabled !== undefined && $('drmEnabled')) $('drmEnabled').value = String(state.drmEnabled);
  if (state.band !== undefined) setSelectedBand(state.band);
  if (state.sameFre !== undefined && $('sameFre')) $('sameFre').checked = Boolean(state.sameFre);

  populateFreqSelects(getSelectedBand(), { keepSelection: false });

  if (state.minfre !== undefined && $('minfre')) $('minfre').value = String(state.minfre);
  if (state.maxfre !== undefined && $('maxfre')) $('maxfre').value = String(state.maxfre);
  syncRegionConstraints();

  if (state.retryTimes !== undefined && $('retryTimes')) $('retryTimes').value = String(state.retryTimes);
  if (state.checkAntEnabled !== undefined && $('checkAntEnabled')) $('checkAntEnabled').value = String(state.checkAntEnabled);
  if (state.relayValue !== undefined && $('relayValue')) $('relayValue').value = String(state.relayValue);
  if (state.gpioValue !== undefined && $('gpioValue')) $('gpioValue').value = String(state.gpioValue);

  updateBeepToggleUi();
}

function applyInfoToBasic(info) {
  if (!info || typeof info !== 'object') return;
  if ($('infoFirmware')) $('infoFirmware').value = String(info.firmware || '');
  if ($('infoDeviceId')) $('infoDeviceId').value = String(info.deviceId || '');
  if ($('infoReaderType')) {
    const hex = info.readerTypeHex ? `0x${info.readerTypeHex}` : info.readerType !== undefined ? `0x${Number(info.readerType).toString(16).toUpperCase().padStart(2, '0')}` : '';
    $('infoReaderType').value = hex;
  }

  if (info.powerDbm !== undefined && $('power')) $('power').value = String(info.powerDbm);
  if (info.beep !== undefined && $('beepEnabled')) $('beepEnabled').value = String(Number(info.beep) ? 1 : 0);

  updateBeepToggleUi();

  if (info.band !== undefined) setSelectedBand(info.band);
  populateFreqSelects(getSelectedBand(), { keepSelection: true });
  if (info.minIdx !== undefined && $('minfre')) $('minfre').value = String(info.minIdx);
  if (info.maxIdx !== undefined && $('maxfre')) $('maxfre').value = String(info.maxIdx);
  syncRegionConstraints();
}

async function fetchInfo({ quiet = false } = {}) {
  let data;
  try {
    const res = await fetch('/api/info');
    data = await res.json();
  } catch (e) {
    if (!quiet) toast('Ma’lumot olish uchun serverga ulanib bo‘lmadi.', 'err', { ttlMs: 6500 });
    logLine('Ma’lumot: serverga ulanib bo‘lmadi.');
    throw e;
  }
  if (!data?.ok) throw new Error(String(data?.error || 'Ma’lumotni olish muvaffaqiyatsiz'));
  applyInfoToBasic(data.result);
  setBasicOut(data.result);
  try {
    saveUiState();
  } catch {
    // ignore
  }
  if (!quiet) toast('Qurilma ma’lumoti olindi.', 'ok');
  logLine('Qurilma ma’lumoti olindi.');
  return data.result;
}

function compactHex(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^0x/i, '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
}

function isHexStrict(hex) {
  return /^[0-9A-F]*$/.test(hex);
}

function extractHexDigits(raw) {
  return String(raw ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
}

function groupHex(hex) {
  const s = String(hex || '');
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(s.slice(i, i + 2));
  return out.join(' ').trim();
}

function hexToAscii(hex) {
  const s = String(hex || '');
  let out = '';
  for (let i = 0; i + 1 < s.length; i += 2) {
    const byte = Number.parseInt(s.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) break;
    out += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.';
  }
  return out;
}

function rwBankName(mem) {
  const m = Number(mem);
  if (m === 0) return 'Password';
  if (m === 1) return 'EPC';
  if (m === 2) return 'TID';
  if (m === 3) return 'User';
  return `Bank ${m}`;
}

function getRwParams() {
  const passwordRaw = compactHex($('rwPwd')?.value);
  return {
    mem: Number($('rwMem')?.value ?? 3),
    wordPtr: Number($('rwWordPtr')?.value ?? 0),
    num: Number($('rwNum')?.value ?? 2),
    password: passwordRaw || '00000000',
  };
}

function updateRwMeta() {
  const el = $('rwMeta');
  if (!el) return;

  const mem = Number($('rwMem')?.value ?? 3);
  const bank = rwBankName(mem);
  const wordPtr = Number($('rwWordPtr')?.value ?? 0);
  const num = Number($('rwNum')?.value ?? 0);
  const epc = compactHex($('rwEpc')?.value);
  const pwdRaw = compactHex($('rwPwd')?.value);
  const pwd = pwdRaw || '00000000';
  const data = compactHex($('rwData')?.value);

  const readBytes = Number.isFinite(num) ? Math.max(0, num) * 2 : 0;
  const writeBytes = data ? Math.floor(data.length / 2) : 0;
  const writeWords = data ? data.length / 4 : 0;

  const warnings = [];
  if (!epc) warnings.push('EPC kiritilmagan (tag jadvalidan tanlang).');
  else if (!isHexStrict(epc) || epc.length % 2 !== 0) warnings.push('EPC faqat hex va uzunligi juft bo‘lishi kerak.');

  if (!isHexStrict(pwd) || pwd.length !== 8) warnings.push('Access parol 8 ta hex bo‘lishi kerak (masalan: 00000000).');

  if (data) {
    if (!isHexStrict(data) || data.length % 2 !== 0) warnings.push('Data faqat hex va uzunligi juft bo‘lishi kerak.');
    if (data.length % 4 !== 0) warnings.push('Data uzunligi 4 ga karrali bo‘lsin (1 word = 4 hex).');
  }

  if (mem === 1 && wordPtr === 0) warnings.push('EPC bankda odatda EPC Word Ptr=2 dan boshlanadi (0=CRC, 1=PC).');
  if (mem === 0) warnings.push('Password bank bilan ehtiyot bo‘ling (odatda tavsiya etilmaydi).');

  const lines = [];
  lines.push(`Bank: ${bank} | Word Ptr: ${wordPtr} | O‘qish: ${num} word (${readBytes} byte)`);
  if (data) lines.push(`Yozish: ${writeWords} word (${writeBytes} byte)`);
  else lines.push("Yozish: (bo‘sh) — 'Yoziladigan data' maydoniga HEX qiymat kiriting (masalan: 11223344).");
  if (warnings.length) lines.push(`Eslatma: ${warnings.join(' ')}`);

  el.textContent = lines.join('\n');
}

function flashField(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add('field-error');
  try {
    el.focus();
  } catch {
    // ignore
  }
  window.setTimeout(() => {
    try {
      el.classList.remove('field-error');
    } catch {
      // ignore
    }
  }, 1800);
}

async function maybeStopInventoryForRw() {
  const cb = $('rwAutoStopInv');
  if (!cb || !cb.checked) return false;
  if (!currentStatus.inventoryStarted) return false;
  try {
    await api('/api/inventory/stop', {});
    await refreshStatus();
    toast('Skan to‘xtatildi (R/W uchun).', 'warn', { ttlMs: 6000 });
    logLine('Skan to‘xtatildi (R/W uchun).');
    return true;
  } catch (e) {
    toast(`Skan to‘xtatib bo‘lmadi: ${humanError(e)}`, 'warn', { ttlMs: 7000 });
    logLine(`Skan to‘xtatib bo‘lmadi: ${humanError(e)}`);
    return false;
  }
}

function buildReadBody() {
  const epc = compactHex($('rwEpc').value);
  const mem = Number($('rwMem').value);
  const wordPtr = Number($('rwWordPtr').value);
  const num = Number($('rwNum').value);
  const passwordRaw = compactHex($('rwPwd').value);
  const password = passwordRaw || '00000000';

  if (!epc) throw new Error('EPC kiritilmagan.');
  if (!isHexStrict(epc) || epc.length % 2 !== 0) throw new Error('EPC faqat hex bo‘lsin (uzunligi juft).');
  if (!isHexStrict(password) || password.length !== 8) throw new Error('Access parol 8 ta hex bo‘lishi kerak (masalan: 00000000).');
  if (!Number.isFinite(wordPtr) || wordPtr < 0) throw new Error('Word Ptr noto‘g‘ri.');
  if (!Number.isFinite(num) || num <= 0) throw new Error('O‘qiladigan word soni noto‘g‘ri.');

  return { epc, mem, wordPtr, num, password };
}

function buildWriteBody() {
  const epc = compactHex($('rwEpc').value);
  const mem = Number($('rwMem').value);
  const wordPtr = Number($('rwWordPtr').value);
  const passwordRaw = compactHex($('rwPwd').value);
  const password = passwordRaw || '00000000';
  const dataRaw = String($('rwData').value || '');
  const data = compactHex(dataRaw);

  if (!epc) throw new Error('EPC kiritilmagan.');
  if (!isHexStrict(epc) || epc.length % 2 !== 0) throw new Error('EPC faqat hex bo‘lsin (uzunligi juft).');
  if (!isHexStrict(password) || password.length !== 8) throw new Error('Access parol 8 ta hex bo‘lishi kerak (masalan: 00000000).');
  if (!data) {
    if (dataRaw.trim()) throw new Error('Data maydonida hex belgi topilmadi (faqat 0-9, A-F).');
    throw new Error('Yoziladigan data bo‘sh.');
  }
  if (!isHexStrict(data) || data.length % 2 !== 0) throw new Error('Data faqat hex bo‘lsin (uzunligi juft).');
  if (data.length % 4 !== 0) throw new Error('Data uzunligi 4 ga karrali bo‘lishi kerak (1 word = 4 hex).');

  return { epc, mem, wordPtr, password, data };
}

function formatReadOutput(result, body) {
  const lines = [];
  lines.push(`Bank: ${rwBankName(body.mem)} | Word Ptr: ${body.wordPtr} | So‘raldi: ${body.num} word`);

  const raw = result?.data;
  if (raw == null || raw === '') {
    lines.push('Natija: (bo‘sh)');
    lines.push('Eslatma: tag masofasini, antenna/maska, region/quvvat va parolni tekshiring.');
    return lines.join('\n');
  }

  const rawStr = String(raw).trim();
  lines.push(`Raw: ${rawStr}`);

  const extracted = extractHexDigits(rawStr);
  if (extracted && extracted.length % 2 === 0) {
    const bytes = extracted.length / 2;
    const words = extracted.length / 4;
    lines.push(`Hex: ${groupHex(extracted)}`);
    lines.push(`Uzunligi: ${Number.isInteger(words) ? `${words} word (${bytes} byte)` : `${bytes} byte`}`);
    lines.push(`ASCII: ${hexToAscii(extracted)}`);
  }

  return lines.join('\n');
}

function formatWriteOutput(result, body) {
  const lines = [];
  const bytes = body.data.length / 2;
  const words = body.data.length / 4;
  const rc = result?.rc;
  lines.push(`Bank: ${rwBankName(body.mem)} | Word Ptr: ${body.wordPtr} | Data: ${words} word (${bytes} byte)`);
  if (rc !== undefined) lines.push(`Natija: rc=${rc}${Number(rc) === 0 ? ' (OK)' : ''}`);
  lines.push(`Data: ${groupHex(body.data)}`);
  return lines.join('\n');
}

function renderAntennaChoices() {
  const count = Number($('readerType').value || 16);
  const wrap = $('antennaChoices');
  wrap.innerHTML = '';
  for (let i = 1; i <= count; i++) {
    const id = `ant_${i}`;
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.dataset.ant = String(i);
    const text = document.createElement('span');
    text.textContent = `ANT${i}`;
    label.appendChild(input);
    label.appendChild(text);
    wrap.appendChild(label);
  }
  syncAntennaChecksFromMask();
  for (const cb of wrap.querySelectorAll('input[type="checkbox"]')) {
    cb.addEventListener('change', () => {
      syncAntennaMaskFromChecks();
      saveUiState();
    });
  }
}

function syncAntennaMaskFromChecks() {
  const wrap = $('antennaChoices');
  let mask = 0;
  for (const cb of wrap.querySelectorAll('input[type="checkbox"]')) {
    if (!cb.checked) continue;
    const ant = Number(cb.dataset.ant);
    if (ant >= 1 && ant <= 31) mask |= 1 << (ant - 1);
  }
  $('antennaMask').value = String(mask);
}

function syncAntennaChecksFromMask() {
  const mask = Number($('antennaMask').value || 0);
  const wrap = $('antennaChoices');
  for (const cb of wrap.querySelectorAll('input[type="checkbox"]')) {
    const ant = Number(cb.dataset.ant);
    cb.checked = Boolean(mask & (1 << (ant - 1)));
  }
}

function getInvType() {
  const el = document.querySelector('input[name="invType"]:checked');
  const raw = Number(el?.value);
  return Number.isFinite(raw) ? raw : 0;
}

function updateInvTypeUi() {
  const isMix = getInvType() === 2;
  for (const el of document.querySelectorAll('.inv-mix-only')) el.classList.toggle('hidden', !isMix);
}

function updateInvDigits() {
  const now = Date.now();
  const windowMs = 2000;
  speedMarks = speedMarks.filter((t) => now - t <= windowMs);
  const speed = currentStatus.inventoryStarted ? speedMarks.length / (windowMs / 1000) : 0;
  const runtime = currentStatus.inventoryStarted && invStartedAt ? now - invStartedAt : 0;

  if ($('statSpeed')) $('statSpeed').textContent = speed ? speed.toFixed(1) : '0';
  if ($('statRuntime')) $('statRuntime').textContent = String(runtime);
}

async function refreshStatus() {
  const res = await fetch('/api/status');
  const data = await res.json();
  if (!data.ok) return;
  applyStatus(data.status);
}

function applyStatus(st) {
  currentStatus = { ...currentStatus, ...(st || {}) };

  if (currentStatus.connected) {
    const mode = currentStatus.lastConnectArgs?.mode || 'tcp';
    if (mode === 'serial') {
      const device = currentStatus.lastConnectArgs?.device;
      const baud = currentStatus.lastConnectArgs?.baud;
      const suffix = device ? ` (${device}${baud ? ` @${baud}` : ''})` : '';
      setStatus(`Qurilma: Ulangan (USB/Serial)${suffix}`, 'ok');
    } else {
      const ip = currentStatus.lastConnectArgs?.ip;
      const port = currentStatus.lastConnectArgs?.port;
      const suffix = ip ? ` (${ip}${port ? `:${port}` : ''})` : '';
      setStatus(`Qurilma: Ulangan (TCP)${suffix}`, 'ok');
    }
  } else {
    setStatus('Qurilma: Ulanmagan', 'err');
  }

  setInventory(Boolean(currentStatus.inventoryStarted));

  if (currentStatus.inventoryStarted && !invStartedAt) {
    invStartedAt = Date.now();
    speedMarks = [];
  }
  if (!currentStatus.inventoryStarted) {
    invStartedAt = 0;
    speedMarks = [];
  }
  updateInvDigits();

  setLocked($('btnConnect'), Boolean(currentStatus.connected));
  setLocked($('btnDisconnect'), !currentStatus.connected);
  setLocked($('btnInfo'), !currentStatus.connected);

  setLocked($('btnInvStart'), !currentStatus.connected || Boolean(currentStatus.inventoryStarted));
  setLocked($('btnInvStop'), !currentStatus.connected || !Boolean(currentStatus.inventoryStarted));

  const requireConn = [
    'btnInvApply',
    'btnAntScan',
    'btnInvOnce',
    'btnRead',
    'btnWrite',
    'btnSetPower',
    'btnSetRegion',
    'btnSetBeep',
    'btnBeepToggle',
    'btnSetDrm',
    'btnRetryGet',
    'btnRetrySet',
    'btnCheckAntSet',
    'btnRelaySet',
    'btnGpioGet',
    'btnGpioSet',
  ];
  for (const id of requireConn) setLocked($(id), !currentStatus.connected);
}

function bind() {
  // Tabs (main + sub)
  const mainTabs = $('mainTabs');
  if (mainTabs) {
    mainTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-main]');
      if (!btn) return;
      const main = String(btn.dataset.main || '');
      const sub = activeSubs[main] || DEFAULT_SUBS[main] || firstSub(main);
      setView(main, sub);
    });
  }

  const subTabs = $('subTabs');
  if (subTabs) {
    subTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-sub]');
      if (!btn) return;
      const sub = String(btn.dataset.sub || '');
      setView(activeMain, sub);
    });
  }

  window.addEventListener('hashchange', () => {
    const v = parseHash();
    if (!v) return;
    setView(v.main, v.sub, { updateHash: false });
  });

  if ($('btnGotoRealtime')) {
    $('btnGotoRealtime').onclick = () => {
      setView('c1g2', 'realtime');
    };
  }
  if ($('btnGotoRealtime2')) $('btnGotoRealtime2').onclick = () => setView('c1g2', 'realtime');
  if ($('btnGotoRealtime3')) $('btnGotoRealtime3').onclick = () => setView('c1g2', 'realtime');

  // Theme toggle
  if ($('themeToggle')) {
    $('themeToggle').onclick = () => {
      toggleTheme();
    };
  }

  for (const id of [
    'connMode',
    'ip',
    'port',
    'serialDevice',
    'serialBaud',
    'readerType',
    'logSwitch',
    'power',
    'beepEnabled',
    'drmEnabled',
    'minfre',
    'maxfre',
    'sameFre',
    'retryTimes',
    'checkAntEnabled',
    'relayValue',
    'gpioValue',
    'qValue',
    'session',
    'scanTime',
    'antennaMask',
    'invMem',
    'invPwd',
    'invTarget',
    'invRetryCount',
    'invAutoClear',
    'invNoRepeat',
    'invShowPhase',
    'tagFilter',
    'tidPtr',
    'tidLen',
    'autoConnect',
  ]) {
    $(id).addEventListener('change', () => {
      if (id === 'connMode') {
        updateConnUi();
        if (String($('connMode').value) === 'serial') refreshSerialList({ quiet: true });
      }
      if (id === 'readerType') {
        renderAntennaChoices();
        populateTagViewAntOptions({ keep: true });
        scheduleTagViewRender();
      }
      if (id === 'antennaMask') syncAntennaChecksFromMask();
      if (id === 'scanTime') clampIntField('scanTime', { min: 1, max: 255, fallback: 20 });
      if (id === 'beepEnabled') updateBeepToggleUi();
      if (id === 'minfre') syncRegionConstraints({ source: 'min' });
      if (id === 'maxfre') syncRegionConstraints({ source: 'max' });
      if (id === 'sameFre') syncRegionConstraints({ source: 'same' });
      if (id === 'invPwd') $('invPwd').value = compactHex($('invPwd').value).slice(0, 8).padStart(8, '0');
      if (id === 'invShowPhase') renderTags();
      if (id === 'invNoRepeat') scheduleTagViewRender();
      saveUiState();
    });
  }

  for (const el of document.querySelectorAll('input[name="bandRadio"]')) {
    el.addEventListener('change', () => {
      populateFreqSelects(getSelectedBand(), { keepSelection: false });
      syncRegionConstraints({ source: 'band' });
      saveUiState();
    });
  }

  for (const el of document.querySelectorAll('input[name="invType"]')) {
    el.addEventListener('change', () => {
      updateInvTypeUi();
      saveUiState();
    });
  }

  if ($('tagFilter')) {
    $('tagFilter').addEventListener('input', () => {
      renderTags();
      try {
        saveUiState();
      } catch {
        // ignore
      }
    });
  }

  if ($('tagViewMode')) {
    populateTagViewAntOptions({ keep: true });
    for (const id of ['tagViewMode', 'tagViewSort', 'tagViewAnt']) {
      $(id).addEventListener('change', () => {
        renderTagView();
        try {
          saveUiState();
        } catch {
          // ignore
        }
      });
    }
    if ($('tagViewFilter')) {
      $('tagViewFilter').addEventListener('input', () => {
        $('tagViewFilter').value = compactHex($('tagViewFilter').value);
        scheduleTagViewRender();
        try {
          saveUiState();
        } catch {
          // ignore
        }
      });
    }
    if ($('btnTagViewClear')) {
      $('btnTagViewClear').onclick = () => {
        tags.clear();
        totalReads = 0;
        selectedEpc = '';
        invStartedAt = 0;
        speedMarks = [];
        setText('statUnique', '0');
        setText('statTotal', '0');
        setText('statSpeed', '0');
        setText('statRuntime', '0');
        setText('statLast', '-');
        renderTags();
        renderTagView();
        toast('Taglar ro‘yxati tozalandi.', 'ok');
        logLine('Taglar ro‘yxati tozalandi.');
      };
    }
    if ($('btnTagViewExport')) {
      $('btnTagViewExport').onclick = () => {
        try {
          const csv = buildTagViewCsv();
          downloadTextFile('tags-antenna.csv', csv, 'text/csv');
          toast('CSV tayyorlandi.', 'ok');
        } catch (e) {
          toast(`CSV xatosi: ${humanError(e)}`, 'err', { ttlMs: 6500 });
        }
      };
    }
  }

  if ($('antReportAnt')) {
    populateAntReportAntOptions({ keep: true });
    renderAntReport();

    for (const id of ['antReportAnt', 'antReportSort']) {
      $(id).addEventListener('change', () => {
        renderAntReport();
        try {
          saveUiState();
        } catch {
          // ignore
        }
      });
    }

    if ($('antReportFilter')) {
      $('antReportFilter').addEventListener('input', () => {
        $('antReportFilter').value = compactHex($('antReportFilter').value);
        scheduleTagViewRender();
        try {
          saveUiState();
        } catch {
          // ignore
        }
      });
    }

    if ($('btnAntReportExport')) {
      $('btnAntReportExport').onclick = () => {
        try {
          const csv = buildAntReportCsv();
          const { ant } = getAntReportParams();
          downloadTextFile(`antenna-ant${ant}.csv`, csv, 'text/csv');
          toast('CSV tayyorlandi.', 'ok');
        } catch (e) {
          toast(`CSV xatosi: ${humanError(e)}`, 'err', { ttlMs: 6500 });
        }
      };
    }
  }

  for (const id of ['rwEpc', 'rwMem', 'rwWordPtr', 'rwNum', 'rwPwd', 'rwData', 'rwAutoStopInv']) {
    $(id).addEventListener('input', () => {
      updateRwMeta();
    });
    $(id).addEventListener('change', () => {
      if (id === 'rwEpc' || id === 'rwPwd' || id === 'rwData') {
        $(id).value = compactHex($(id).value);
      }
      updateRwMeta();
      saveUiState();
    });
  }

  $('btnConnect').onclick = async () => {
    await runBusy($('btnConnect'), 'Ulanmoqda…', async () => {
      try {
        setStatus('Qurilma: Ulanmoqda…', 'warn');
        const args = getConnArgs();
        if (args.mode === 'serial') {
          if (!args.device) {
            flashField('serialDevice');
            throw new Error('USB/Serial qurilma kiritilmagan (masalan: /dev/ttyUSB0 yoki COM3).');
          }
        } else if (!args.ip) {
          flashField('ip');
          throw new Error('IP kiritilmagan.');
        }
        await api('/api/connect', args);
        await refreshStatus();
        try {
          await fetchInfo({ quiet: true });
        } catch {
          // ignore
        }
        toast('Ulandi.', 'ok');
        logLine('Ulandi.');
      } catch (e) {
        setStatus('Qurilma: Ulanmagan', 'err');
        toast(`Ulanish xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Ulanish xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnScan').onclick = async () => {
    await runBusy($('btnScan'), 'Skan qilinmoqda…', async () => {
      try {
        if (String($('connMode').value || 'tcp') === 'serial') {
          await refreshSerialList();
          return;
        }
        const port = Number($('port').value || 27011);
        const ports = [...new Set([port, 27011, 2022])]
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
        logLine(`Tarmoq skan qilinmoqda (portlar: ${ports.join(', ') || '—'})...`);
        const result = await api('/api/scan', { ports });
        if (!result?.devices?.length) {
          toast('Skan tugadi: qurilma topilmadi.', 'warn', { ttlMs: 6000 });
          logLine(`Skan tugadi. ${result?.subnet || 'local tarmoq'} da qurilma topilmadi.`);
          return;
        }
        toast(`Skan tugadi: ${result.devices.length} ta qurilma topildi.`, 'ok');
        logLine(
          `Skan tugadi. Topildi (${result.devices.length}): ${result.devices.map((d) => `${d.ip}:${d.port}`).join(', ')}`,
        );
        $('ip').value = result.devices[0].ip;
        if (result.devices[0].port) $('port').value = String(result.devices[0].port);
        saveUiState();
      } catch (e) {
        toast(`Skan xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Skan xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnDisconnect').onclick = async () => {
    await runBusy($('btnDisconnect'), 'Uzilmoqda…', async () => {
      try {
        await api('/api/disconnect', {});
        await refreshStatus();
        toast('Ulanish uzildi.', 'ok');
        logLine('Ulanish uzildi.');
      } catch (e) {
        toast(`Ulanishni uzish xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Ulanishni uzish xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnInfo').onclick = async () => {
    await runBusy($('btnInfo'), 'Yuklanmoqda…', async () => {
      try {
        await fetchInfo();
      } catch (e) {
        toast(`Ma’lumot olish xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Ma’lumot olish xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnInvStart').onclick = async () => {
    await runBusy($('btnInvStart'), 'Boshlanmoqda…', async () => {
      try {
        const invParams = getInvParams();
        validateInvParams(invParams);

        if ($('invAutoClear')?.checked) {
          tags.clear();
          totalReads = 0;
          selectedEpc = '';
          setText('statUnique', '0');
          setText('statTotal', '0');
          setText('statLast', '-');
        }
        renderTags();
        scheduleTagViewRender();
        invStartedAt = Date.now();
        speedMarks = [];
        updateInvDigits();
        await api('/api/inventory/params', invParams);
        await api('/api/inventory/start', {});
        toast('Skan boshlandi.', 'ok');
        logLine('Skan boshlandi.');
        await refreshStatus();
      } catch (e) {
        const msg = humanError(e);
        toast(`Skan boshlash xatosi: ${msg}`, 'err', { ttlMs: 7000 });
        logLine(`Skan boshlash xatosi: ${msg}`);
        if (msg.includes('Cannot set properties of null') || msg.includes('Cannot read properties of null')) {
          maybeLogStack('Skan boshlash stack', e);
        }
      }
    });
  };

  if ($('btnInvOnce')) {
    $('btnInvOnce').onclick = async () => {
      await runBusy($('btnInvOnce'), 'Kutilmoqda…', async () => {
        const wasRunning = Boolean(currentStatus.inventoryStarted);
        let startedHere = false;
        const waitP = waitForInvOnceTag({ timeoutMs: 9000 });
        try {
          const invParams = getInvParams();
          validateInvParams(invParams);

          if (!wasRunning) {
            await api('/api/inventory/params', invParams);
            await api('/api/inventory/start', {});
            startedHere = true;
            invStartedAt = Date.now();
            speedMarks = [];
            updateInvDigits();
            try {
              await refreshStatus();
            } catch {
              // ignore
            }
          }

          toast('Bir marta o‘qish: tag kutilyapti…', 'warn', { ttlMs: 3500 });
          logLine('Bir marta o‘qish: tag kutilyapti…');

          const { epc } = await waitP;

          try {
            await api('/api/inventory/stop', {});
          } catch {
            // ignore
          }
          invStartedAt = 0;
          speedMarks = [];
          updateInvDigits();
          try {
            await refreshStatus();
          } catch {
            // ignore
          }

          selectedEpc = epc;
          if ($('rwEpc')) $('rwEpc').value = epc;
          updateRwMeta();
          renderTags();
          scheduleTagViewRender();
          setView('c1g2', 'rw');

          toast(`Topildi: ${epc}`, 'ok');
          logLine(`Bir marta o‘qish: ${epc}`);
        } catch (e) {
          const msg = humanError(e);
          toast(`Bir marta o‘qish xatosi: ${msg}`, 'err', { ttlMs: 7000 });
          logLine(`Bir marta o‘qish xatosi: ${msg}`);
          try {
            cancelInvOnce('error');
            // Ensure pending promise is settled to avoid unhandled rejections.
            await waitP;
          } catch {
            // ignore
          }
          if (startedHere) {
            try {
              await api('/api/inventory/stop', {});
            } catch {
              // ignore
            }
            try {
              await refreshStatus();
            } catch {
              // ignore
            }
          }
        } finally {
          cancelInvOnce('done');
        }
      });
    };
  }

  if ($('btnInvApply')) {
    $('btnInvApply').onclick = async () => {
      await runBusy($('btnInvApply'), 'Qo‘llanmoqda…', async () => {
        try {
          const invParams = getInvParams();
          validateInvParams(invParams);

          const wasRunning = Boolean(currentStatus.inventoryStarted);
          if (wasRunning) await api('/api/inventory/stop', {});

          await api('/api/inventory/params', invParams);

          if (wasRunning) {
            await api('/api/inventory/start', {});
            invStartedAt = Date.now();
            speedMarks = [];
            updateInvDigits();
          }

          toast(
            wasRunning ? 'Inventar sozlamalari qo‘llandi (skan qayta boshlandi).' : 'Inventar sozlamalari qo‘llandi.',
            'ok',
          );
          logLine(wasRunning ? 'Inventar sozlamalari qo‘llandi (skan qayta boshlandi).' : 'Inventar sozlamalari qo‘llandi.');
          await refreshStatus();
        } catch (e) {
          toast(`Inventar sozlamalari xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
          logLine(`Inventar sozlamalari xatosi: ${humanError(e)}`);
        }
      });
    };
  }

  if ($('btnAntScan')) {
    $('btnAntScan').onclick = async () => {
      await runBusy($('btnAntScan'), 'Tekshirilmoqda…', async () => {
        try {
          if (currentStatus.inventoryStarted) {
            try {
              await api('/api/inventory/stop', {});
            } catch {
              // ignore
            }
            try {
              await refreshStatus();
            } catch {
              // ignore
            }
          }

          const countRaw = Number($('readerType')?.value ?? 16);
          const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(31, Math.trunc(countRaw))) : 16;
          const freqKhz = guessReturnLossFreqKhz();
          const mhzLabel = formatMhz(freqKhz / 1000);

          toast(`Antenna skan (ReturnLoss): ${mhzLabel} MHz…`, 'warn', { ttlMs: 3500 });
          logLine(`Antenna skan boshlandi (ReturnLoss), freq=${mhzLabel} MHz, count=${count}`);

          const res = await api('/api/antenna/scan', { freqKhz, count });
          const results = Array.isArray(res?.results) ? res.results : [];
          if (!results.length) {
            toast('Antenna skan tugadi: natija yo‘q.', 'warn', { ttlMs: 6500 });
            logLine('Antenna skan tugadi: natija yo‘q.');
            return;
          }

          const parts = [];
          let mask = 0;
          for (const r of results) {
            const ant = Number(r?.ant ?? 0);
            const rc = Number(r?.rc ?? -1);
            const rl = Number(r?.returnLoss ?? 0);
            if (rc === 0) {
              parts.push(`ANT${ant}: ${rl} dB`);
              if (ant >= 1 && ant <= 31) mask |= 1 << (ant - 1);
            } else {
              parts.push(`ANT${ant}: rc=${rc}`);
            }
          }

          logLine(`Antenna skan natija: ${parts.join(', ')}`);
          if (mask) {
            $('antennaMask').value = String(mask);
            syncAntennaChecksFromMask();
            saveUiState();
            toast(`Antenna maskasi yangilandi: ${mask}`, 'ok');
          } else {
            toast('Antenna skan tugadi: hech bir antenna OK qaytarmadi.', 'warn', { ttlMs: 7000 });
          }
        } catch (e) {
          toast(`Antenna skan xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
          logLine(`Antenna skan xatosi: ${humanError(e)}`);
        }
      });
    };
  }

  $('btnInvStop').onclick = async () => {
    await runBusy($('btnInvStop'), 'To‘xtatilmoqda…', async () => {
      try {
        await api('/api/inventory/stop', {});
        invStartedAt = 0;
        speedMarks = [];
        updateInvDigits();
        toast('Skan to‘xtatildi.', 'ok');
        logLine('Skan to‘xtatildi.');
        await refreshStatus();
      } catch (e) {
        toast(`Skan to‘xtatish xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Skan to‘xtatish xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnInvClear').onclick = () => {
    tags.clear();
    totalReads = 0;
    selectedEpc = '';
    invStartedAt = 0;
    speedMarks = [];
    setText('statUnique', '0');
    setText('statTotal', '0');
    setText('statSpeed', '0');
    setText('statRuntime', '0');
    setText('statLast', '-');
    renderTags();
    scheduleTagViewRender();
    toast('Taglar ro‘yxati tozalandi.', 'ok');
    logLine('Taglar ro‘yxati tozalandi.');
  };

  if ($('btnBeepToggle')) {
    $('btnBeepToggle').onclick = async () => {
      await runBusy($('btnBeepToggle'), 'Sozlanmoqda…', async () => {
        try {
          const sel = $('beepEnabled');
          const cur = Number(sel?.value ?? 1) !== 0 ? 1 : 0;
          const next = cur ? 0 : 1;
          const result = await api('/api/settings/beep', { enabled: next });
          setBasicOut({ action: 'SET_BEEP', ...result });
          if (sel) sel.value = String(next);
          try {
            await fetchInfo({ quiet: true });
          } catch {
            // ignore
          }
          updateBeepToggleUi();
          saveUiState();
          toast(next ? 'Tovush yoqildi.' : 'Tovush o‘chirildi.', 'ok');
          logLine(next ? 'Beep yoqildi.' : 'Beep o‘chirildi.');
        } catch (e) {
          updateBeepToggleUi();
          toast(`Tovush sozlash xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
          logLine(`Tovush sozlash xatosi: ${humanError(e)}`);
        }
      });
    };
    updateBeepToggleUi();
  }

  if ($('btnTagsExport')) {
    $('btnTagsExport').onclick = () => {
      try {
        const csv = buildTagsCsv();
        const name = `tags_${new Date().toISOString().replaceAll(':', '').slice(0, 15)}.csv`;
        downloadTextFile(name, csv, 'text/csv');
        toast('CSV yuklab olindi.', 'ok');
      } catch (e) {
        toast(`CSV xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
      }
    };
  }

  const applyRwPreset = ({ mem, wordPtr, num }) => {
    $('rwMem').value = String(mem);
    $('rwWordPtr').value = String(wordPtr);
    $('rwNum').value = String(num);
    updateRwMeta();
    saveUiState();
    toast('Tez sozlama qo‘llandi.', 'ok');
  };

  $('btnPresetEpc').onclick = () => applyRwPreset({ mem: 1, wordPtr: 2, num: 6 });
  $('btnPresetTid').onclick = () => applyRwPreset({ mem: 2, wordPtr: 0, num: 6 });
  $('btnPresetUser').onclick = () => applyRwPreset({ mem: 3, wordPtr: 0, num: 2 });

  $('btnRead').onclick = async () => {
    await runBusy($('btnRead'), 'O‘qilmoqda…', async () => {
      try {
        await maybeStopInventoryForRw();
        const body = buildReadBody();
        const result = await api('/api/read', body);
        setText('rwOut', formatReadOutput(result, body));
        toast('O‘qish tugadi.', 'ok');
        logLine('O‘qish tugadi.');
      } catch (e) {
        const msg = humanError(e);
        setText('rwOut', msg);
        if (msg.includes('EPC')) flashField('rwEpc');
        if (msg.toLowerCase().includes('parol')) flashField('rwPwd');
        if (msg.includes('Word Ptr')) flashField('rwWordPtr');
        toast(`O‘qish xatosi: ${msg}`, 'err', { ttlMs: 7000 });
        logLine(`O‘qish xatosi: ${msg}`);
      } finally {
        updateRwMeta();
      }
    });
  };

  $('btnWrite').onclick = async () => {
    await runBusy($('btnWrite'), 'Yozilmoqda…', async () => {
      try {
        await maybeStopInventoryForRw();
        const body = buildWriteBody();

        const bytes = body.data.length / 2;
        const words = body.data.length / 4;
        const bank = rwBankName(body.mem);
        const extraWarn =
          body.mem === 0 || body.mem === 1
            ? '\nDIQQAT: Password/EPC bankga yozish tagni buzib qo‘yishi mumkin. Agar ishonchingiz komil bo‘lmasa, User bankdan foydalaning.'
            : '';

        const ok = window.confirm(
          `Yozishni tasdiqlaysizmi?\n\nBank: ${bank}\nWord Ptr: ${body.wordPtr}\nData: ${words} word (${bytes} byte)\n${extraWarn}`,
        );
        if (!ok) {
          toast('Yozish bekor qilindi.', 'warn');
          logLine('Yozish bekor qilindi.');
          return;
        }

        const result = await api('/api/write', body);
        setText('rwOut', formatWriteOutput(result, body));
        toast('Yozish tugadi.', 'ok');
        logLine('Yozish tugadi.');
      } catch (e) {
        const msg = humanError(e);
        setText('rwOut', msg);
        if (msg.toLowerCase().includes('data')) flashField('rwData');
        if (msg.includes('EPC')) flashField('rwEpc');
        if (msg.toLowerCase().includes('parol')) flashField('rwPwd');
        if (msg.includes('Word Ptr')) flashField('rwWordPtr');
        toast(`Yozish xatosi: ${msg}`, 'err', { ttlMs: 7000 });
        logLine(`Yozish xatosi: ${msg}`);
      } finally {
        updateRwMeta();
      }
    });
  };

  $('btnSetPower').onclick = async () => {
    await runBusy($('btnSetPower'), 'Sozlanmoqda…', async () => {
      try {
        const result = await api('/api/settings/power', { power: Number($('power').value) });
        setBasicOut({ action: 'SET_POWER', ...result });
        try {
          await fetchInfo({ quiet: true });
        } catch {
          // ignore
        }
        toast('Quvvat yangilandi.', 'ok');
        logLine('Quvvat sozlandi.');
      } catch (e) {
        toast(`Quvvat sozlash xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Quvvat sozlash xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnSetRegion').onclick = async () => {
    await runBusy($('btnSetRegion'), 'Sozlanmoqda…', async () => {
      try {
        syncRegionConstraints({ source: 'set' });
        const result = await api('/api/settings/region', {
          band: getSelectedBand(),
          maxfre: Number($('maxfre').value),
          minfre: Number($('minfre').value),
        });
        setBasicOut({ action: 'SET_REGION', ...result });
        try {
          await fetchInfo({ quiet: true });
        } catch {
          // ignore
        }
        toast('Region yangilandi.', 'ok');
        logLine('Region sozlandi.');
      } catch (e) {
        toast(`Region sozlash xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Region sozlash xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnSetBeep').onclick = async () => {
    await runBusy($('btnSetBeep'), 'Sozlanmoqda…', async () => {
      try {
        const enabled = Number($('beepEnabled').value);
        const result = await api('/api/settings/beep', { enabled });
        setBasicOut({ action: 'SET_BEEP', ...result });
        try {
          await fetchInfo({ quiet: true });
        } catch {
          // ignore
        }
        toast('Beep yangilandi.', 'ok');
        logLine('Beep sozlandi.');
      } catch (e) {
        toast(`Beep sozlash xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Beep sozlash xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnSetDrm').onclick = async () => {
    await runBusy($('btnSetDrm'), 'Sozlanmoqda…', async () => {
      try {
        const enabled = Number($('drmEnabled').value);
        const result = await api('/api/settings/drm', { enabled });
        setBasicOut({ action: 'SET_DRM', ...result });
        toast('DRM sozlandi.', 'ok');
        logLine('DRM sozlandi.');
      } catch (e) {
        toast(`DRM sozlash xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`DRM sozlash xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnRetryGet').onclick = async () => {
    await runBusy($('btnRetryGet'), 'O‘qilmoqda…', async () => {
      try {
        const result = await api('/api/settings/retry', { op: 'get' });
        if (result?.times !== undefined && $('retryTimes')) $('retryTimes').value = String(result.times);
        setBasicOut({ action: 'GET_RETRY', ...result });
        saveUiState();
        toast('Retry times o‘qildi.', 'ok');
        logLine('Retry times o‘qildi.');
      } catch (e) {
        toast(`Retry times xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Retry times xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnRetrySet').onclick = async () => {
    await runBusy($('btnRetrySet'), 'Sozlanmoqda…', async () => {
      try {
        const times = Number($('retryTimes').value);
        const result = await api('/api/settings/retry', { op: 'set', times });
        setBasicOut({ action: 'SET_RETRY', ...result });
        saveUiState();
        toast('Retry times sozlandi.', 'ok');
        logLine('Retry times sozlandi.');
      } catch (e) {
        toast(`Retry times sozlash xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Retry times sozlash xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnCheckAntSet').onclick = async () => {
    await runBusy($('btnCheckAntSet'), 'Sozlanmoqda…', async () => {
      try {
        const enabled = Number($('checkAntEnabled').value);
        const result = await api('/api/settings/check-ant', { enabled });
        setBasicOut({ action: 'SET_CHECK_ANT', ...result });
        saveUiState();
        toast('Antenna detection sozlandi.', 'ok');
        logLine('Antenna detection sozlandi.');
      } catch (e) {
        toast(`CheckAnt xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`CheckAnt xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnRelaySet').onclick = async () => {
    await runBusy($('btnRelaySet'), 'Sozlanmoqda…', async () => {
      try {
        const value = Number($('relayValue').value);
        const result = await api('/api/settings/relay', { value });
        setBasicOut({ action: 'SET_RELAY', ...result });
        saveUiState();
        toast('Relay sozlandi.', 'ok');
        logLine('Relay sozlandi.');
      } catch (e) {
        toast(`Relay xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Relay xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnGpioGet').onclick = async () => {
    await runBusy($('btnGpioGet'), 'O‘qilmoqda…', async () => {
      try {
        const result = await api('/api/settings/gpio', { op: 'get' });
        setBasicOut({ action: 'GPIO_GET', ...result });
        toast('GPIO holati o‘qildi.', 'ok');
        logLine('GPIO holati o‘qildi.');
      } catch (e) {
        toast(`GPIO o‘qish xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`GPIO o‘qish xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnGpioSet').onclick = async () => {
    await runBusy($('btnGpioSet'), 'Sozlanmoqda…', async () => {
      try {
        const result = await api('/api/settings/gpio', { op: 'set', value: Number($('gpioValue').value) });
        setBasicOut({ action: 'GPIO_SET', ...result });
        toast('GPIO yozildi.', 'ok');
        logLine('GPIO yozildi.');
      } catch (e) {
        toast(`GPIO yozish xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`GPIO yozish xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnLogsClear').onclick = () => {
    setText('logs', '');
    toast('Loglar tozalandi.', 'ok');
  };

  $('btnLogsCopy').onclick = async () => {
    try {
      const text = $('logs')?.textContent || '';
      await navigator.clipboard.writeText(text);
      toast('Loglar nusxalandi (clipboard).', 'ok');
    } catch (e) {
      toast('Nusxalab bo‘lmadi (brauzer clipboardni blokladi).', 'warn', { ttlMs: 6500 });
    }
  };
}

function startEvents() {
  backendConnected = false;
  window.clearTimeout(backendErrTimer);
  setBackend('warn');
  backendErrTimer = window.setTimeout(() => {
    if (!backendConnected) setBackend('err');
  }, 5000);
  const ev = new EventSource('/api/events');
  ev.addEventListener('hello', (e) => {
    backendConnected = true;
    window.clearTimeout(backendErrTimer);
    try {
      const data = JSON.parse(e.data);
      setBackend(true, data?.host || '');
    } catch {
      setBackend(true);
    }
    const now = Date.now();
    if (now - backendToastAt > 8000) {
      backendToastAt = now;
      toast('Server ishga tushdi.', 'ok');
    }
    logLine(`Event stream ulandi: ${e.data}`);
  });
  ev.addEventListener('TAG', (e) => {
    try {
      const tag = JSON.parse(e.data);
      upsertTag(tag);
    } catch {
      // ignore
    }
  });
  ev.addEventListener('STATUS', (e) => {
    try {
      const patch = JSON.parse(e.data);
      applyStatus({ ...currentStatus, ...patch });
    } catch {
      // ignore
    }
    logLine(`STATUS: ${e.data}`);
  });
  ev.addEventListener('log', (e) => {
    try {
      const m = JSON.parse(e.data);
      logLine(`${m.level}: ${String(m.message).trim()}`);
    } catch {
      logLine(e.data);
    }
  });
  ev.onerror = () => {
    backendConnected = false;
    window.clearTimeout(backendErrTimer);
    setBackend('warn');
    backendErrTimer = window.setTimeout(() => {
      if (!backendConnected) setBackend('err');
    }, 5000);
    logLine('Event stream xatosi (avtomatik qayta ulanadi).');
  };
}

function humanError(err) {
  const msg = String(err && err.message ? err.message : err).trim();
  if (!msg) return 'Noma’lum xato';
  if (msg.includes('Timeout waiting for')) {
    return `${msg}. Qurilma band yoki ulanish yo‘q bo‘lishi mumkin; IP/portni tekshirib qayta urinib ko‘ring.`;
  }
  if (msg.includes('Connect failed: 48')) {
    return 'Ulanish vaqti tugadi (rc=48). USB/Serialda baud noto‘g‘ri bo‘lishi mumkin: 57600/115200 yoki Baud=0 (Auto) qilib ko‘ring.';
  }
  if (msg.includes('Connect failed: -1')) {
    return 'USB/Serial port ochilmadi (rc=-1). Qurilma yo‘li (/dev/ttyUSB0) va ruxsatni tekshiring (dialout/uucp).';
  }
  if (msg.toLowerCase().includes('not connected')) return 'Ulanmagan (avval ulanib oling).';
  return msg;
}

function maybeLogStack(prefix, err) {
  try {
    const stack = err && err.stack ? String(err.stack).trim() : '';
    if (!stack) return;
    logLine(`${prefix}\n${stack}`);
  } catch {
    // ignore
  }
}

function initAloqaUi() {
  const urlEl = $('erpUrl');
  if (!urlEl) return;

  const authEl = $('erpAuth');
  const deviceEl = $('erpDevice');
  const agentEl = $('erpAgentId');
  const pushEl = $('erpPushEnabled');
  const rpcEl = $('erpRpcEnabled');
  const hintEl = $('erpConfigHint');
  const outEl = $('erpOut');

  const render = (cfg) => {
    const eff = cfg?.effective || {};
    const file = cfg?.file || {};
    const src = cfg?.sources || {};

    const baseUrlVal = String(file.baseUrl || eff.baseUrl || '').trim();
    if (urlEl && document.activeElement !== urlEl) urlEl.value = baseUrlVal;
    if (deviceEl && document.activeElement !== deviceEl) deviceEl.value = String(file.device || eff.device || '').trim();
    if (agentEl && document.activeElement !== agentEl) agentEl.value = String(file.agentId || eff.agentId || '').trim();

    if (pushEl) pushEl.checked = Boolean((file.pushEnabled ?? eff.pushEnabled) ?? true);
    if (rpcEl) rpcEl.checked = Boolean((file.rpcEnabled ?? eff.rpcEnabled) ?? true);

    const parts = [];
    parts.push(`Push: ${eff.pushActive ? 'ON' : 'OFF'}`);
    parts.push(`RPC: ${eff.rpcActive ? 'ON' : 'OFF'}`);
    parts.push(`URL: ${eff.baseUrl || '-'}`);
    parts.push(`Token: ${eff.authSet ? eff.authMasked || '(set)' : 'yo‘q'}`);
    parts.push(`Config: ${cfg?.config_path || '-'}`);
    if (src.baseUrl === 'env' || src.auth === 'env') {
      parts.push('ENV override bor (UI’dan o‘zgarmasligi mumkin).');
    }
    if (hintEl) hintEl.textContent = parts.join(' · ');

    if (outEl) outEl.textContent = JSON.stringify(cfg, null, 2);
  };

  const refresh = async ({ quiet = false } = {}) => {
    try {
      const cfg = await apiGet('/api/erp/config');
      render(cfg);
      if (!quiet) logLine('Aloqa: ERP config yuklandi.');
    } catch (e) {
      if (!quiet) toast(`ERP config xatosi: ${humanError(e)}`, 'warn', { ttlMs: 7000 });
      if (hintEl) hintEl.textContent = `ERP config olinmadi: ${String(e?.message || e)}`;
    }
  };

  $('btnErpSave').onclick = async () => {
    await runBusy($('btnErpSave'), 'Saqlanmoqda…', async () => {
      try {
        const payload = {
          baseUrl: String(urlEl?.value || '').trim(),
          device: String(deviceEl?.value || '').trim(),
          agentId: String(agentEl?.value || '').trim(),
          pushEnabled: Boolean(pushEl?.checked),
          rpcEnabled: Boolean(rpcEl?.checked),
        };
        const auth = String(authEl?.value || '').trim();
        if (auth) payload.auth = auth;
        const r = await api('/api/erp/config', payload);
        try {
          if (authEl) authEl.value = '';
        } catch {
          // ignore
        }
        render(r);
        toast('ERP sozlamalari saqlandi.', 'ok');
        logLine('Aloqa: ERP sozlamalari saqlandi.');
      } catch (e) {
        toast(`Saqlash xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Aloqa: saqlash xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnErpClear').onclick = async () => {
    await runBusy($('btnErpClear'), 'O‘chirilmoqda…', async () => {
      try {
        const r = await api('/api/erp/config', { clearAuth: true });
        try {
          if (authEl) authEl.value = '';
        } catch {
          // ignore
        }
        render(r);
        toast('Token o‘chirildi.', 'ok');
        logLine('Aloqa: token o‘chirildi.');
      } catch (e) {
        toast(`Token o‘chirish xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Aloqa: token o‘chirish xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnErpTest').onclick = async () => {
    await runBusy($('btnErpTest'), 'Tekshirilmoqda…', async () => {
      try {
        const payload = {};
        const baseUrl = String(urlEl?.value || '').trim();
        const auth = String(authEl?.value || '').trim();
        if (baseUrl) payload.baseUrl = baseUrl;
        if (auth) payload.auth = auth;
        const result = await api('/api/erp/test', payload);
        if (outEl) outEl.textContent = JSON.stringify(result, null, 2);
        if (result?.ping?.ok && (result?.auth?.ok || result?.auth?.error === 'Token kiritilmagan.')) {
          toast('Test: OK', 'ok');
        } else {
          toast('Test: muammo bor (chiqishni ko‘ring).', 'warn', { ttlMs: 7000 });
        }
        logLine(`Aloqa: ERP test: ${JSON.stringify(result)}`);
      } catch (e) {
        toast(`Test xatosi: ${humanError(e)}`, 'err', { ttlMs: 7000 });
        logLine(`Aloqa: test xatosi: ${humanError(e)}`);
      }
    });
  };

  $('btnErpCopy').onclick = async () => {
    try {
      const baseUrl = String(urlEl?.value || '').trim() || '<ERP_URL>';
      const auth = String(authEl?.value || '').trim() || 'token <APIKEY>:<APISECRET>';
      const device = String(deviceEl?.value || '').trim() || 'my-reader-pc';
      const agentId = String(agentEl?.value || '').trim() || device;
      const pushEnabled = Boolean(pushEl?.checked);
      const rpcEnabled = Boolean(rpcEl?.checked);

      const lines = [
        `export ERP_PUSH_URL=\"${baseUrl}\"`,
        `export ERP_PUSH_AUTH=\"${auth}\"`,
        `export ERP_PUSH_DEVICE=\"${device}\"`,
        `export ERP_AGENT_ID=\"${agentId}\"`,
        `export ERP_PUSH_ENABLED=\"${pushEnabled ? '1' : '0'}\"`,
        `export ERP_RPC_ENABLED=\"${rpcEnabled ? '1' : '0'}\"`,
      ].join('\n');

      await navigator.clipboard.writeText(lines);
      toast('Env nusxalandi (clipboard).', 'ok');
    } catch (e) {
      try {
        const baseUrl = String(urlEl?.value || '').trim() || '<ERP_URL>';
        const auth = String(authEl?.value || '').trim() || 'token <APIKEY>:<APISECRET>';
        const device = String(deviceEl?.value || '').trim() || 'my-reader-pc';
        const agentId = String(agentEl?.value || '').trim() || device;
        const pushEnabled = Boolean(pushEl?.checked);
        const rpcEnabled = Boolean(rpcEl?.checked);
        const text = [
          `export ERP_PUSH_URL=\"${baseUrl}\"`,
          `export ERP_PUSH_AUTH=\"${auth}\"`,
          `export ERP_PUSH_DEVICE=\"${device}\"`,
          `export ERP_AGENT_ID=\"${agentId}\"`,
          `export ERP_PUSH_ENABLED=\"${pushEnabled ? '1' : '0'}\"`,
          `export ERP_RPC_ENABLED=\"${rpcEnabled ? '1' : '0'}\"`,
        ].join('\n');
        downloadTextFile('rfidenter-env.txt', text);
        toast('Clipboard bloklandi — fayl yuklab berildi.', 'warn', { ttlMs: 7000 });
      } catch {
        toast('Nusxalab bo‘lmadi.', 'err', { ttlMs: 7000 });
      }
    }
  };

  refresh({ quiet: true }).catch(() => {});
}

async function init() {
  // Initialize theme first
  const savedTheme = getTheme();
  setTheme(savedTheme);

  loadUiState();
  updateConnUi();
  updateInvTypeUi();
  clampIntField('scanTime', { min: 1, max: 255, fallback: 20, quiet: true });
  const fromHash = parseHash();
  const initialMain = fromHash?.main || activeMain;
  const initialSub = fromHash?.sub || activeSubs[initialMain] || DEFAULT_SUBS[initialMain] || firstSub(initialMain);
  setView(initialMain, initialSub, { updateHash: false, save: false, scroll: false });
  renderAntennaChoices();
  initRegionUi();
  if (pendingBasicState) applyBasicState(pendingBasicState);
  bind();
  initAloqaUi();
  updateRwMeta();
  scheduleTagViewRender();
  startEvents();
  window.setInterval(updateInvDigits, 500);
  try {
    await refreshStatus();
  } catch {
    // ignore
  }

  if (String($('connMode').value || 'tcp') === 'serial') {
    await refreshSerialList({ quiet: true });
  }

  if ($('autoConnect').checked) {
    $('btnConnect').click();
  }
}

init();
