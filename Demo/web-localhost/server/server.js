#!/usr/bin/env node
/* eslint-disable no-console */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { URL } = require('url');

function envStr(name, fallback = '') {
  const v = process.env[name];
  return v == null ? fallback : String(v);
}

function envInt(name, fallback) {
  const raw = envStr(name, '');
  if (!raw.trim()) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parseBool(raw, fallback) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return Boolean(fallback);
  if (['1', 'true', 'yes', 'y', 'on', 'enable', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disable', 'disabled'].includes(s)) return false;
  return Boolean(fallback);
}

function envBool(name, fallback) {
  const raw = envStr(name, '').trim();
  if (!raw) return Boolean(fallback);
  return parseBool(raw, fallback);
}

function normalizeBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function normalizeHttpUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return normalizeBaseUrl(s);
}

function maskAuth(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const token = s.toLowerCase().startsWith('token ') ? s.slice(6).trim() : s;
  const [key, secret] = token.split(':');
  if (!key) return '***';
  const k = key.length <= 6 ? key : `${key.slice(0, 3)}…${key.slice(-2)}`;
  const sec = secret ? `${'*'.repeat(Math.min(6, secret.length))}` : '';
  return secret ? `token ${k}:${sec}` : `token ${k}`;
}

function loadLocalConfig(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { erp: {} };
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { erp: {} };
    const erp = parsed.erp && typeof parsed.erp === 'object' ? parsed.erp : {};
    return { erp };
  } catch {
    return { erp: {} };
  }
}

function saveLocalConfig(filePath, cfg) {
  const data = cfg && typeof cfg === 'object' ? cfg : { erp: {} };
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

class ErpPusher {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = typeof log === 'function' ? log : () => {};
    this.queue = [];
    this.timer = null;
    this.failCount = 0;
    this.backoffUntil = 0;
    this.lastWarnAt = 0;
  }

  enabled() {
    return Boolean(this.cfg?.enabled);
  }

  enqueue(tag) {
    if (!this.enabled()) return;
    if (!tag || typeof tag !== 'object') return;

    this.queue.push({ ...tag, ts: Date.now() });
    const maxQueue = this.cfg.maxQueue;
    if (Number.isFinite(maxQueue) && maxQueue > 0 && this.queue.length > maxQueue) {
      this.queue.splice(0, this.queue.length - maxQueue);
    }
    this.#schedule();
  }

  #schedule() {
    if (this.timer) return;
    const waitMs = Math.max(50, this.cfg.batchMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, waitMs);
    try {
      this.timer.unref();
    } catch {
      // ignore
    }
  }

  async flush() {
    if (!this.enabled()) return;
    if (!this.queue.length) return;

    const now = Date.now();
    if (this.backoffUntil && now < this.backoffUntil) {
      this.#schedule();
      return;
    }

    const batch = this.queue.splice(0, this.cfg.maxBatch);
    if (!batch.length) return;

    try {
      await this.#send(batch);
      this.failCount = 0;
      this.backoffUntil = 0;
    } catch (e) {
      // Drop data on repeated failures; keep UI responsive.
      this.failCount += 1;
      const backoffMs = Math.min(30_000, 500 * 2 ** Math.min(10, this.failCount));
      this.backoffUntil = Date.now() + backoffMs;
      const msg = String(e && e.message ? e.message : e);
      if (Date.now() - this.lastWarnAt > 5000) {
        this.lastWarnAt = Date.now();
        this.log(`ERP push xatosi: ${msg}`);
      }
    } finally {
      if (this.queue.length) this.#schedule();
    }
  }

  async #send(tags) {
    const url = `${this.cfg.baseUrl}${this.cfg.endpoint}`;
    const headers = { 'content-type': 'application/json' };

    const auth = String(this.cfg.auth || '').trim();
    if (auth) headers.authorization = auth.toLowerCase().startsWith('token ') ? auth : `token ${auth}`;

    const secret = String(this.cfg.secret || '').trim();
    if (secret) headers['x-rfidenter-token'] = secret;

    const payload = { device: this.cfg.device, tags, ts: Date.now() };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.ok === false) throw new Error(String(data.error || 'ERP response not ok'));
  }
}

function listLocalIpv4() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const [, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      const ip = String(addr.address || '').trim();
      if (!ip) continue;
      ips.push(ip);
    }
  }
  return [...new Set(ips)];
}

function buildUiUrls({ host, port }) {
  const urls = [];
  const seen = new Set();
  const add = (raw) => {
    const u = normalizeBaseUrl(raw);
    if (!u) return;
    if (seen.has(u)) return;
    seen.add(u);
    urls.push(u);
  };

  const publicUrl = envStr('NODE_PUBLIC_URL', envStr('RFID_PUBLIC_URL', ''));
  if (publicUrl) add(publicUrl);

  // Always include localhost (works when ERP is opened on the same PC)
  add(`http://127.0.0.1:${port}`);

  const h = String(host || '').trim();
  if (h === '0.0.0.0' || h === '::') {
    for (const ip of listLocalIpv4()) add(`http://${ip}:${port}`);
  } else if (h && h !== '127.0.0.1' && h.toLowerCase() !== 'localhost') {
    add(`http://${h}:${port}`);
  }

  return urls;
}

function parseArgs(argv) {
  const args = { port: 8787, host: '127.0.0.1' };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--port') args.port = Number(argv[++i]);
    else if (v === '--host') args.host = String(argv[++i]);
  }
  return args;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

class Bridge {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = '';
  }

  onEvent(handler) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  emit(evt) {
    for (const handler of this.listeners) handler(evt);
  }

  start() {
    if (this.proc) return;

    const bridgeOutDir = path.resolve(this.rootDir, 'server', 'bridge-out');
    const uhfJar = path.resolve(this.rootDir, '..', '..', 'SDK', 'Java-linux', 'CReader_Uhf.jar');
    const legacyJar = path.resolve(this.rootDir, '..', '..', 'SDK', 'Java-linux', 'CReader.jar');
    const sdkJar = fs.existsSync(uhfJar) ? uhfJar : legacyJar;
    const mainClass = 'com.st8504.bridge.BridgeMain';

    const classPath = [bridgeOutDir, sdkJar].join(path.delimiter);
    const javaArgs = ['-cp', classPath, mainClass];

    if (!fs.existsSync(sdkJar)) {
      throw new Error(`Missing SDK jar at: ${sdkJar} (expected CReader_Uhf.jar or CReader.jar)`);
    }
    if (!fs.existsSync(path.join(bridgeOutDir, 'com', 'st8504', 'bridge', 'BridgeMain.class'))) {
      throw new Error(`Java bridge is not built. Run: ${path.resolve(this.rootDir, 'build-bridge.sh')}`);
    }

    this.proc = spawn('java', javaArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.#handleStdout(chunk));

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.emit({ type: 'bridge-stderr', message: String(chunk) });
    });

    this.proc.on('exit', (code, signal) => {
      const msg = `Java bridge exited (code=${code}, signal=${signal})`;
      for (const [, p] of this.pending) p.reject(new Error(msg));
      this.pending.clear();
      this.proc = null;
      this.emit({ type: 'bridge-exit', message: msg });
    });
  }

  stop() {
    if (!this.proc) return;
    this.proc.kill();
    this.proc = null;
  }

  #handleStdout(chunk) {
    this.buffer += chunk;
    while (true) {
      const idx = this.buffer.indexOf('\n');
      if (idx === -1) return;
      const line = this.buffer.slice(0, idx).trimEnd();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.#handleLine(line);
    }
  }

  #handleLine(line) {
    const parts = line.split('\t');
    const kind = parts[0];

    if (kind === 'RES') {
      const id = Number(parts[1]);
      const okOrErr = parts[2];
      const payload = parts.slice(3).join('\t');
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (okOrErr === 'OK') pending.resolve(payload ? JSON.parse(payload) : {});
      else pending.reject(new Error(payload || 'Unknown error'));
      return;
    }

    if (kind === 'EVT') {
      const evtType = parts[1];
      const payload = parts.slice(2).join('\t');
      let data = payload;
      try {
        data = payload ? JSON.parse(payload) : {};
      } catch {
        // Keep raw
      }
      this.emit({ type: 'bridge-event', event: evtType, data });
      return;
    }

    this.emit({ type: 'bridge-unknown', line });
  }

  request(cmd, args = {}) {
    this.start();
    const id = this.nextId++;
    const line = `REQ\t${id}\t${cmd}\t${JSON.stringify(args)}\n`;

    return new Promise((resolve, reject) => {
      const timeoutMs = Number(process.env.BRIDGE_TIMEOUT_MS || 30_000);
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${cmd}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      this.proc.stdin.write(line);
    });
  }
}

function serveStatic({ webDir }, req, res) {
  const urlObj = new URL(req.url, 'http://127.0.0.1');
  let pathname = urlObj.pathname;
  if (pathname === '/') pathname = '/index.html';
  pathname = pathname.replaceAll('..', '');
  const filePath = path.join(webDir, pathname);
  if (!filePath.startsWith(webDir)) return false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
  return true;
}

function findDefaultSubnet() {
  const ifaces = os.networkInterfaces();
  for (const [, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      // Heuristic: use /24 of the first non-internal IPv4
      const parts = addr.address.split('.');
      if (parts.length !== 4) continue;
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
  }
  return null;
}

function listSerialDevices() {
  const devices = [];
  const seen = new Set();

  function add(devicePath, kind, extra = {}) {
    if (!devicePath) return;
    if (seen.has(devicePath)) return;
    seen.add(devicePath);
    devices.push({ path: devicePath, kind, ...(extra || {}) });
  }

  const platform = process.platform;
  if (platform === 'linux') {
    try {
      for (const name of fs.readdirSync('/dev')) {
        if (/^tty(USB|ACM)\\d+$/.test(name)) add(path.join('/dev', name), 'dev');
      }
    } catch {}

    for (const dir of ['/dev/serial/by-id', '/dev/serial/by-path']) {
      try {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) add(path.join(dir, name), path.basename(dir));
      } catch {}
    }
  } else if (platform === 'darwin') {
    try {
      for (const name of fs.readdirSync('/dev')) {
        if (name.startsWith('tty.') || name.startsWith('cu.')) add(path.join('/dev', name), 'dev');
      }
    } catch {}
  } else if (platform === 'win32') {
    const candidates = [];
    const winSeen = new Set();

    const normalizeCom = (value) => {
      const m = String(value || '').toUpperCase().match(/COM\\d+/);
      return m ? m[0] : '';
    };

    const winScore = ({ port, name, pnpId }) => {
      const p = String(port || '').toUpperCase();
      const n = String(name || '').toUpperCase();
      const pnp = String(pnpId || '').toUpperCase();
      let score = 0;
      if (pnp.startsWith('USB')) score += 100;
      if (pnp.includes('USB')) score += 60;
      if (n.includes('USB')) score += 40;
      if (n.includes('CH340') || n.includes('FTDI') || n.includes('CP210') || n.includes('SILICON LABS')) score += 20;
      if (n.includes('BLUETOOTH')) score -= 40;
      const num = Number(/COM(\\d+)/i.exec(p)?.[1] || 0);
      if (Number.isFinite(num)) score += Math.min(99, num) / 10;
      if (p === 'COM1') score -= 5;
      return score;
    };

    const push = (port, kind, extra = {}) => {
      const normalized = normalizeCom(port);
      if (!normalized) return;
      if (winSeen.has(normalized)) return;
      winSeen.add(normalized);
      const name = extra?.name ? String(extra.name) : '';
      const pnpId = extra?.pnpId ? String(extra.pnpId) : '';
      candidates.push({
        port: normalized,
        kind,
        name,
        pnpId,
        score: winScore({ port: normalized, name, pnpId }),
      });
    };

    const run = (cmd, args) => {
      try {
        const r = spawnSync(cmd, args, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 2500,
        });
        if (r?.error) return '';
        return String(r.stdout || '').trim();
      } catch {
        return '';
      }
    };

    const runPowerShell = (script) => {
      const args = ['-NoProfile', '-Command', script];
      return run('powershell', args) || run('pwsh', args);
    };

    const extractComList = (text) => {
      const out = [];
      const re = /COM\\d+/gi;
      const s = String(text || '');
      let m;
      while ((m = re.exec(s))) out.push(m[0].toUpperCase());
      return [...new Set(out)];
    };

    // 1) Best-effort: get Name + PNPDeviceID (so we can prioritize USB serial devices)
    const psJson = runPowerShell(
      [
        '$ports = @(Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue);',
        'if (!$ports) { $ports = @(Get-WmiObject Win32_SerialPort -ErrorAction SilentlyContinue) };',
        '$ports | Select-Object DeviceID,PNPDeviceID,Name | ConvertTo-Json -Compress',
      ].join(' '),
    );
    if (psJson) {
      try {
        const parsed = JSON.parse(psJson);
        const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        for (const it of list) {
          const port = it?.DeviceID;
          const name = it?.Name || '';
          const pnpId = it?.PNPDeviceID || '';
          push(port, 'win-wmi', { name, pnpId });
        }
      } catch {
        for (const port of extractComList(psJson)) push(port, 'win-wmi');
      }
    }

    // 2) Fallback: raw port list (no names)
    if (!candidates.length) {
      const psPorts = runPowerShell('[System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object');
      for (const port of extractComList(psPorts)) push(port, 'win-ports');
    }

    // 3) Fallback: registry query
    if (!candidates.length) {
      const regOut =
        run('reg', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM']) ||
        run('cmd', ['/c', 'reg', 'query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM']);
      for (const port of extractComList(regOut)) push(port, 'win-reg');
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Prefer higher COM number if score ties
      const an = Number(/COM(\\d+)/i.exec(a.port)?.[1] || 0);
      const bn = Number(/COM(\\d+)/i.exec(b.port)?.[1] || 0);
      if (bn !== an) return bn - an;
      return a.port.localeCompare(b.port);
    });

    for (const c of candidates) add(c.port, c.kind, { name: c.name, pnpId: c.pnpId });
  }

  return { platform, devices };
}

const DEFAULT_TCP_PORTS = [27011, 2022];

function normalizePorts(list) {
  const out = [];
  const seen = new Set();
  for (const v of list || []) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

async function tryTcpConnect({ ip, port, timeoutMs }) {
  return await new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    function finish(result) {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve(result);
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip);
  });
}

async function scanTcpPort({ port, timeoutMs = 120, concurrency = 64 }) {
  const subnet = findDefaultSubnet();
  if (!subnet) return { subnet: null, devices: [] };

  const base = subnet.split('/')[0].split('.');
  const prefix = `${base[0]}.${base[1]}.${base[2]}.`;

  const ips = [];
  for (let i = 1; i <= 254; i++) ips.push(`${prefix}${i}`);

  const devices = [];
  let idx = 0;

  async function worker() {
    while (true) {
      const ip = ips[idx++];
      if (!ip) return;
      const ok = await tryTcpConnect({ ip, port, timeoutMs });
      if (ok) devices.push({ ip, port });
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  return { subnet, devices };
}

async function scanTcpPorts({ ports, timeoutMs = 120, concurrency = 64 }) {
  const list = normalizePorts(ports);
  if (!list.length) return { subnet: null, devices: [], portsTried: [] };

  const subnet = findDefaultSubnet();
  if (!subnet) return { subnet: null, devices: [], portsTried: list };

  const base = subnet.split('/')[0].split('.');
  const prefix = `${base[0]}.${base[1]}.${base[2]}.`;

  const ips = [];
  for (let i = 1; i <= 254; i++) ips.push(`${prefix}${i}`);

  const devices = [];
  let idx = 0;

  async function worker() {
    while (true) {
      const ip = ips[idx++];
      if (!ip) return;
      for (const port of list) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await tryTcpConnect({ ip, port, timeoutMs });
        if (ok) {
          devices.push({ ip, port });
          break;
        }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  return { subnet, devices, portsTried: list };
}

function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  const webDir = path.resolve(rootDir, 'web');

  const bridge = new Bridge({ rootDir });

  const sseClients = new Set();
  function sseBroadcast(event, data) {
    const payload = JSON.stringify(data);
    const msg = `event: ${event}\ndata: ${payload}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(msg);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  const localConfigPath = path.resolve(rootDir, 'server', 'local-config.json');
  const localCfg = loadLocalConfig(localConfigPath);

  const getFileErp = () => (localCfg && typeof localCfg === 'object' && localCfg.erp && typeof localCfg.erp === 'object' ? localCfg.erp : {});

  const computeEffectiveErp = () => {
    const fileErp = getFileErp();

    const envBaseUrl = normalizeHttpUrl(envStr('ERP_PUSH_URL', envStr('ERP_URL', '')));
    const fileBaseUrl = normalizeHttpUrl(fileErp.baseUrl || '');
    const baseUrl = envBaseUrl || fileBaseUrl;

    const envAuth = String(envStr('ERP_PUSH_AUTH', envStr('ERP_PUSH_TOKEN', '')) || '').trim();
    const fileAuth = String(fileErp.auth || '').trim();
    const auth = envAuth || fileAuth;

    const envDevice = String(envStr('ERP_PUSH_DEVICE', '') || '').trim();
    const fileDevice = String(fileErp.device || '').trim();
    const device = envDevice || fileDevice || os.hostname();

    const envAgentId = String(envStr('ERP_AGENT_ID', '') || '').trim();
    const fileAgentId = String(fileErp.agentId || '').trim();
    const agentId = envAgentId || fileAgentId || device;

    const pushEnabled = envBool('ERP_PUSH_ENABLED', fileErp.pushEnabled !== false);
    const rpcEnabled = envBool('ERP_RPC_ENABLED', fileErp.rpcEnabled !== false);

    const sources = {
      baseUrl: envBaseUrl ? 'env' : fileBaseUrl ? 'file' : '',
      auth: envAuth ? 'env' : fileAuth ? 'file' : '',
      device: envDevice ? 'env' : fileDevice ? 'file' : 'default',
      agentId: envAgentId ? 'env' : fileAgentId ? 'file' : 'default',
      pushEnabled: process.env.ERP_PUSH_ENABLED ? 'env' : 'file',
      rpcEnabled: process.env.ERP_RPC_ENABLED ? 'env' : 'file',
    };

    return { baseUrl, auth, device, agentId, pushEnabled, rpcEnabled, sources };
  };

  let erpEffective = computeEffectiveErp();

  const erpCfg = {
    baseUrl: erpEffective.baseUrl,
    endpoint: envStr('ERP_PUSH_ENDPOINT', '/api/method/rfidenter.rfidenter.api.ingest_tags'),
    auth: erpEffective.auth,
    secret: envStr('ERP_PUSH_SECRET', envStr('RFIDENTER_TOKEN', '')),
    device: erpEffective.device,
    pushEnabled: erpEffective.pushEnabled,
    rpcEnabled: erpEffective.rpcEnabled,
    batchMs: envInt('ERP_PUSH_BATCH_MS', 250),
    maxBatch: Math.max(1, envInt('ERP_PUSH_MAX_BATCH', 200)),
    maxQueue: Math.max(200, envInt('ERP_PUSH_MAX_QUEUE', 5000)),
  };
  erpCfg.enabled = Boolean(erpCfg.baseUrl && erpCfg.pushEnabled);

  const erpPush = new ErpPusher(erpCfg, (m) => {
    try {
      sseBroadcast('log', { level: 'info', message: m });
    } catch {
      // ignore
    }
  });

  const agentCfg = {
    baseUrl: erpCfg.baseUrl,
    endpoint: envStr('ERP_AGENT_ENDPOINT', '/api/method/rfidenter.rfidenter.api.register_agent'),
    auth: erpCfg.auth,
    secret: erpCfg.secret,
    device: erpCfg.device,
    agentId: erpEffective.agentId,
    intervalMs: Math.max(2000, envInt('ERP_AGENT_INTERVAL_MS', 10000)),
    version: envStr('ERP_AGENT_VERSION', 'rfid-web-localhost'),
  };
  agentCfg.enabled = Boolean(agentCfg.baseUrl && String(agentCfg.auth || '').trim() && erpCfg.rpcEnabled);

  let lastAgentWarnAt = 0;
  async function registerAgentOnce() {
    if (!agentCfg.enabled) return;
    const url = `${agentCfg.baseUrl}${agentCfg.endpoint}`;
    const headers = { 'content-type': 'application/json' };

    const auth = String(agentCfg.auth || '').trim();
    if (auth) headers.authorization = auth.toLowerCase().startsWith('token ') ? auth : `token ${auth}`;

    const secret = String(agentCfg.secret || '').trim();
    if (secret) headers['x-rfidenter-token'] = secret;

    const payload = {
      agent_id: agentCfg.agentId,
      device: agentCfg.device,
      ui_urls: buildUiUrls({ host: args.host, port: args.port }),
      ui_host: args.host,
      ui_port: args.port,
      platform: process.platform,
      version: agentCfg.version,
      pid: process.pid,
      ts: Date.now(),
    };

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
  }

  function startAgentHeartbeat() {
    const tick = async () => {
      if (!agentCfg.enabled) return;
      try {
        await registerAgentOnce();
      } catch (e) {
        if (Date.now() - lastAgentWarnAt > 5000) {
          lastAgentWarnAt = Date.now();
          const msg = String(e && e.message ? e.message : e);
          try {
            sseBroadcast('log', { level: 'warn', message: `Agent register xatosi: ${msg}` });
          } catch {
            // ignore
          }
        }
      }
    };

    tick().catch(() => {});
    const t = setInterval(() => tick().catch(() => {}), agentCfg.intervalMs);
    try {
      t.unref();
    } catch {
      // ignore
    }
  }

  const rpcCfg = {
    enabled: Boolean(agentCfg.enabled),
    pollEndpoint: envStr('ERP_RPC_POLL_ENDPOINT', '/api/method/rfidenter.rfidenter.api.agent_poll'),
    replyEndpoint: envStr('ERP_RPC_REPLY_ENDPOINT', '/api/method/rfidenter.rfidenter.api.agent_reply'),
    pollMs: Math.max(150, envInt('ERP_RPC_POLL_MS', 800)),
    max: Math.max(1, envInt('ERP_RPC_POLL_MAX', 5)),
  };

  function applyErpEffective(next, { broadcast = false } = {}) {
    if (!next || typeof next !== 'object') return;
    erpEffective = next;

    erpCfg.baseUrl = String(next.baseUrl || '').trim();
    erpCfg.auth = String(next.auth || '').trim();
    erpCfg.device = String(next.device || '').trim() || os.hostname();
    erpCfg.pushEnabled = Boolean(next.pushEnabled);
    erpCfg.rpcEnabled = Boolean(next.rpcEnabled);
    erpCfg.enabled = Boolean(erpCfg.baseUrl && erpCfg.pushEnabled);

    agentCfg.baseUrl = erpCfg.baseUrl;
    agentCfg.auth = erpCfg.auth;
    agentCfg.device = erpCfg.device;
    agentCfg.agentId = String(next.agentId || '').trim() || erpCfg.device;
    agentCfg.enabled = Boolean(agentCfg.baseUrl && String(agentCfg.auth || '').trim() && erpCfg.rpcEnabled);

    rpcCfg.enabled = Boolean(agentCfg.enabled);

    if (broadcast) {
      try {
        sseBroadcast('log', {
          level: 'info',
          message: `ERP config yangilandi: push=${erpCfg.enabled ? 'on' : 'off'} rpc=${rpcCfg.enabled ? 'on' : 'off'} url=${erpCfg.baseUrl || '-'}`,
        });
      } catch {
        // ignore
      }
    }
  }

  function getErpUiConfig() {
    const fileErp = getFileErp();
    const fileBaseUrl = normalizeHttpUrl(fileErp.baseUrl || '');
    const fileAuth = String(fileErp.auth || '').trim();
    const fileDevice = String(fileErp.device || '').trim();
    const fileAgentId = String(fileErp.agentId || '').trim();

    const cfg = computeEffectiveErp();
    // Keep in sync with runtime (if env changes at runtime, re-apply)
    if (
      cfg.baseUrl !== erpCfg.baseUrl ||
      cfg.auth !== erpCfg.auth ||
      cfg.device !== erpCfg.device ||
      cfg.agentId !== agentCfg.agentId ||
      Boolean(cfg.pushEnabled) !== Boolean(erpCfg.pushEnabled) ||
      Boolean(cfg.rpcEnabled) !== Boolean(erpCfg.rpcEnabled)
    ) {
      applyErpEffective(cfg);
    }

    return {
      ok: true,
      config_path: localConfigPath,
      effective: {
        baseUrl: erpCfg.baseUrl,
        device: erpCfg.device,
        agentId: agentCfg.agentId,
        pushEnabled: Boolean(erpCfg.pushEnabled),
        rpcEnabled: Boolean(erpCfg.rpcEnabled),
        pushActive: Boolean(erpCfg.enabled),
        rpcActive: Boolean(rpcCfg.enabled),
        authSet: Boolean(String(erpCfg.auth || '').trim()),
        authMasked: maskAuth(erpCfg.auth),
      },
      sources: cfg.sources || {},
      file: {
        baseUrl: fileBaseUrl,
        device: fileDevice,
        agentId: fileAgentId,
        pushEnabled: fileErp.pushEnabled !== false,
        rpcEnabled: fileErp.rpcEnabled !== false,
        authSet: Boolean(fileAuth),
        authMasked: maskAuth(fileAuth),
      },
    };
  }

  function updateLocalErpConfig(patch) {
    const fileErp = { ...getFileErp() };
    const p = patch && typeof patch === 'object' ? patch : {};

    if (Object.prototype.hasOwnProperty.call(p, 'baseUrl')) {
      fileErp.baseUrl = normalizeHttpUrl(p.baseUrl);
    }
    if (Object.prototype.hasOwnProperty.call(p, 'device')) {
      fileErp.device = String(p.device || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(p, 'agentId')) {
      fileErp.agentId = String(p.agentId || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(p, 'pushEnabled')) {
      fileErp.pushEnabled = Boolean(p.pushEnabled);
    }
    if (Object.prototype.hasOwnProperty.call(p, 'rpcEnabled')) {
      fileErp.rpcEnabled = Boolean(p.rpcEnabled);
    }

    if (Object.prototype.hasOwnProperty.call(p, 'auth')) {
      const v = String(p.auth || '').trim();
      if (v) fileErp.auth = v;
    }
    if (p.clearAuth === true) fileErp.auth = '';

    localCfg.erp = fileErp;
    saveLocalConfig(localConfigPath, localCfg);
    applyErpEffective(computeEffectiveErp(), { broadcast: true });

    return getErpUiConfig();
  }

  async function testErpConnection({ baseUrl, auth } = {}) {
    const cfg = computeEffectiveErp();
    const url = normalizeHttpUrl(baseUrl) || cfg.baseUrl;
    const authRaw = String(auth || '').trim() || cfg.auth;

    if (!url) throw new Error('ERP URL kiritilmagan.');

    const authHeader = authRaw ? (authRaw.toLowerCase().startsWith('token ') ? authRaw : `token ${authRaw}`) : '';

    const out = { url, ping: { ok: false }, auth: { ok: false } };

    // 1) Ping (doesn't require auth)
    try {
      const r = await fetch(`${url}/api/method/rfidenter.rfidenter.api.ping`, {
        method: 'GET',
        headers: authHeader ? { authorization: authHeader } : {},
      });
      out.ping.ok = Boolean(r.ok);
      out.ping.status = r.status;
      out.ping.statusText = r.statusText;
    } catch (e) {
      out.ping.ok = false;
      out.ping.error = String(e && e.message ? e.message : e);
    }

    // 2) Auth check (requires RFIDer role)
    if (!authHeader) {
      out.auth.ok = false;
      out.auth.error = 'Token kiritilmagan.';
      return out;
    }

    try {
      const r = await fetch(`${url}/api/method/rfidenter.rfidenter.api.list_agents`, {
        method: 'POST',
        headers: { authorization: authHeader, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      out.auth.ok = Boolean(r.ok);
      out.auth.status = r.status;
      out.auth.statusText = r.statusText;
      if (!r.ok) out.auth.body = String(await r.text().catch(() => '')).slice(0, 300);
    } catch (e) {
      out.auth.ok = false;
      out.auth.error = String(e && e.message ? e.message : e);
    }

    return out;
  }

  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });

  async function erpPost(endpoint, payload) {
    if (!agentCfg.baseUrl) throw new Error('ERP_PUSH_URL yo‘q (ERP URL sozlanmagan)');
    const url = `${agentCfg.baseUrl}${endpoint}`;
    const headers = { 'content-type': 'application/json' };

    const auth = String(agentCfg.auth || '').trim();
    if (auth) headers.authorization = auth.toLowerCase().startsWith('token ') ? auth : `token ${auth}`;

    const secret = String(agentCfg.secret || '').trim();
    if (secret) headers['x-rfidenter-token'] = secret;

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (data && (data._server_messages || data.message || data.error)) ||
        `${res.status} ${res.statusText || 'HTTP error'}`;
      throw new Error(String(msg).slice(0, 300));
    }
    return data && typeof data === 'object' && 'message' in data ? data.message : data;
  }

  async function rpcPollOnce() {
    const msg = await erpPost(rpcCfg.pollEndpoint, { agent_id: agentCfg.agentId, max: rpcCfg.max, ts: Date.now() });
    const commands = Array.isArray(msg?.commands) ? msg.commands : [];
    return commands;
  }

  async function rpcReply({ requestId, ok, result, error }) {
    await erpPost(rpcCfg.replyEndpoint, {
      agent_id: agentCfg.agentId,
      request_id: requestId,
      ok: Boolean(ok),
      result: ok ? result : null,
      error: ok ? '' : String(error || 'Unknown error'),
      ts: Date.now(),
    });
  }

  async function execRpcCommand({ cmd, args }) {
    const c = String(cmd || '').trim();
    const a = args && typeof args === 'object' ? args : {};

    if (c === 'LIST_SERIAL') return listSerialDevices();

    if (c === 'SCAN_TCP') {
      const ports = normalizePorts(a?.ports);
      const fallback = normalizePorts([a?.port, ...DEFAULT_TCP_PORTS]);
      const list = ports.length ? ports : fallback.length ? fallback : DEFAULT_TCP_PORTS;
      return list.length <= 1
        ? await scanTcpPort({ port: list[0] || DEFAULT_TCP_PORTS[0], timeoutMs: 120, concurrency: 64 })
        : await scanTcpPorts({ ports: list, timeoutMs: 120, concurrency: 64 });
    }

    if (c === 'ANTENNA_SCAN') {
      const countRaw = Number(a.count ?? 16);
      const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(31, Math.trunc(countRaw))) : 16;
      const freqKhzRaw = Number(a.freqKhz ?? 902750);
      const freqKhz = Number.isFinite(freqKhzRaw) ? Math.trunc(freqKhzRaw) : 902750;
      if (freqKhz <= 0) throw new Error('freqKhz noto‘g‘ri (masalan: 902750)');

      const results = [];
      for (let i = 1; i <= count; i++) {
        // eslint-disable-next-line no-await-in-loop
        const r = await bridge.request('MEASURE_RETURN_LOSS', { freqKhz, ant: i });
        results.push(r);
      }
      return { freqKhz, results };
    }

    // Default: pass-through to Java bridge command.
    return await bridge.request(c, a);
  }

  function startRpcLoop() {
    const loop = async () => {
      let failCount = 0;
      while (true) {
        if (!rpcCfg.enabled) {
          failCount = 0;
          // idle when RPC is disabled
          // eslint-disable-next-line no-await-in-loop
          await sleep(1000);
          continue;
        }

        try {
          const commands = await rpcPollOnce();
          if (!commands.length) {
            failCount = 0;
            // Small idle sleep to reduce CPU/network
            // eslint-disable-next-line no-await-in-loop
            await sleep(rpcCfg.pollMs);
            continue;
          }

          failCount = 0;
          for (const item of commands) {
            const requestId = String(item?.request_id || item?.requestId || '').trim();
            const cmd = String(item?.cmd || '').trim();
            const args = item?.args;
            if (!requestId || !cmd) continue;

            try {
              const issuedAt = Number(item?.ts || 0);
              const timeoutSecRaw = Number(item?.timeout_sec ?? item?.timeoutSec ?? 30);
              const timeoutSec = Number.isFinite(timeoutSecRaw) ? Math.max(2, Math.min(120, Math.trunc(timeoutSecRaw))) : 30;
              if (issuedAt && Date.now() - issuedAt > (timeoutSec + 5) * 1000) {
                // Don't execute stale commands if the agent was offline.
                // eslint-disable-next-line no-await-in-loop
                await rpcReply({ requestId, ok: false, error: 'Expired (agent offline?)' });
                continue;
              }

              // eslint-disable-next-line no-await-in-loop
              const result = await execRpcCommand({ cmd, args });
              // eslint-disable-next-line no-await-in-loop
              await rpcReply({ requestId, ok: true, result });
            } catch (e) {
              const msg = String(e && e.message ? e.message : e);
              // eslint-disable-next-line no-await-in-loop
              await rpcReply({ requestId, ok: false, error: msg });
            }
          }
        } catch (e) {
          failCount += 1;
          const wait = Math.min(5000, 300 + failCount * 200);
          const msg = String(e && e.message ? e.message : e);
          try {
            sseBroadcast('log', { level: 'warn', message: `RPC poll xatosi: ${msg}` });
          } catch {
            // ignore
          }
          // eslint-disable-next-line no-await-in-loop
          await sleep(wait);
        }
      }
    };

    loop().catch(() => {});
  }

  bridge.onEvent((evt) => {
    if (evt.type === 'bridge-event') {
      sseBroadcast(evt.event, evt.data);
      if (evt.event === 'TAG') erpPush.enqueue(evt.data);
    }
    else if (evt.type === 'bridge-stderr') sseBroadcast('log', { level: 'stderr', message: evt.message });
    else if (evt.type === 'bridge-exit') sseBroadcast('log', { level: 'error', message: evt.message });
  });

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://${args.host}`);

      if (req.method === 'GET' && urlObj.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, host: os.hostname() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'GET' && urlObj.pathname === '/api/status') {
        const status = await bridge.request('STATUS', {});
        return json(res, 200, { ok: true, status });
      }

      if (req.method === 'GET' && urlObj.pathname === '/api/erp/config') {
        const result = getErpUiConfig();
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/erp/config') {
        const body = await readJsonBody(req);
        const result = updateLocalErpConfig(body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/erp/test') {
        const body = await readJsonBody(req);
        const result = await testErpConnection(body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'GET' && urlObj.pathname === '/api/serial/list') {
        const result = listSerialDevices();
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/scan') {
        const body = await readJsonBody(req);
        const ports = normalizePorts(body?.ports);
        const fallback = normalizePorts([body?.port, ...DEFAULT_TCP_PORTS]);
        const list = ports.length ? ports : fallback.length ? fallback : DEFAULT_TCP_PORTS;
        const result =
          list.length <= 1
            ? await scanTcpPort({ port: list[0] || DEFAULT_TCP_PORTS[0], timeoutMs: 120, concurrency: 64 })
            : await scanTcpPorts({ ports: list, timeoutMs: 120, concurrency: 64 });
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/connect') {
        const body = await readJsonBody(req);
        const result = await bridge.request('CONNECT', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/disconnect') {
        const result = await bridge.request('DISCONNECT', {});
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/inventory/params') {
        const body = await readJsonBody(req);
        const result = await bridge.request('SET_INV_PARAM', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/inventory/start') {
        const body = await readJsonBody(req);
        const result = await bridge.request('START_READ', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/inventory/stop') {
        const result = await bridge.request('STOP_READ', {});
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/read') {
        const body = await readJsonBody(req);
        const result = await bridge.request('READ', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/write') {
        const body = await readJsonBody(req);
        const result = await bridge.request('WRITE', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/settings/power') {
        const body = await readJsonBody(req);
        const result = await bridge.request('SET_POWER', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/settings/region') {
        const body = await readJsonBody(req);
        const result = await bridge.request('SET_REGION', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/settings/beep') {
        const body = await readJsonBody(req);
        const result = await bridge.request('SET_BEEP', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/settings/retry') {
        const body = await readJsonBody(req);
        const op = String(body.op || 'get').toLowerCase();
        const result = await bridge.request(op === 'set' ? 'SET_RETRY' : 'GET_RETRY', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/settings/drm') {
        const body = await readJsonBody(req);
        const result = await bridge.request('SET_DRM', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/settings/check-ant') {
        const body = await readJsonBody(req);
        const result = await bridge.request('SET_CHECK_ANT', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/settings/relay') {
        const body = await readJsonBody(req);
        const result = await bridge.request('SET_RELAY', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/settings/gpio') {
        const body = await readJsonBody(req);
        const result = await bridge.request('GPIO', body);
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/antenna/scan') {
        const body = await readJsonBody(req);
        const countRaw = Number(body.count ?? 16);
        const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(31, Math.trunc(countRaw))) : 16;
        const freqKhzRaw = Number(body.freqKhz ?? 902750);
        const freqKhz = Number.isFinite(freqKhzRaw) ? Math.trunc(freqKhzRaw) : 902750;
        if (freqKhz <= 0) throw new Error('freqKhz noto‘g‘ri (masalan: 902750)');

        const results = [];
        for (let i = 1; i <= count; i++) {
          // 1-based antenna index for UI.
          // Bridge converts to 0-based for SDK call.
          // Returns: { rc, ant, freqKhz, returnLoss }
          // eslint-disable-next-line no-await-in-loop
          const r = await bridge.request('MEASURE_RETURN_LOSS', { freqKhz, ant: i });
          results.push(r);
        }

        return json(res, 200, { ok: true, result: { freqKhz, results } });
      }

      if (req.method === 'GET' && urlObj.pathname === '/api/info') {
        const result = await bridge.request('GET_INFO', {});
        return json(res, 200, { ok: true, result });
      }

      if (serveStatic({ webDir }, req, res)) return;

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  server.listen(args.port, args.host, () => {
    console.log(`UHF localhost web UI: http://${args.host}:${args.port}`);
    startAgentHeartbeat();
    startRpcLoop();
  });
}

main();
