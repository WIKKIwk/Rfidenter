/* global frappe */

function escapeHtml(value) {
	const s = String(value ?? "");
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function normalizeBaseUrl(raw) {
	const s = String(raw ?? "").trim();
	if (!s) return "";
	return s.endsWith("/") ? s.slice(0, -1) : s;
}

function clampInt(raw, { min = 0, max = 999999, fallback = 0 } = {}) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

function fmtTime(ts) {
	const n = Number(ts);
	if (!Number.isFinite(n) || n <= 0) return "";
	try {
		return new Date(n).toLocaleString();
	} catch {
		return "";
	}
}

function parseServerTime(raw) {
	const s = String(raw || "").trim();
	if (!s) return 0;
	const ts = Date.parse(s);
	return Number.isFinite(ts) ? ts : 0;
}

function fmtServerTime(raw) {
	const ts = parseServerTime(raw);
	if (!ts) return "--";
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return "--";
	}
}

function isLoopbackUrl(raw) {
	try {
		const u = new URL(String(raw || ""));
		const host = String(u.hostname || "").trim().toLowerCase();
		return host === "127.0.0.1" || host === "localhost" || host === "::1";
	} catch {
		return false;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeEpcHex(raw) {
	return String(raw ?? "")
		.trim()
		.toUpperCase()
		.replace(/[^0-9A-F]/g, "");
}

function newEventId() {
	if (window.crypto?.randomUUID) return window.crypto.randomUUID();
	const rnd = Math.random().toString(16).slice(2, 10);
	return `evt-${Date.now()}-${rnd}`;
}

frappe.pages["rfidenter-zebra"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "RFIDenter — Zebra",
		single_column: true,
	});

	const STORAGE_AUTH = "rfidenter.erp_push_auth";
	const STORAGE_ZEBRA_URL = "rfidenter.zebra_url";
	const STORAGE_CONN_MODE = "rfidenter.zebra.conn_mode"; // agent | local
	const STORAGE_AGENT_ID = "rfidenter.zebra.agent_id";
	const STORAGE_DEVICE_ID = "rfidenter.edge.device_id";
	const STORAGE_BATCH_ID = "rfidenter.edge.batch_id";
	const STORAGE_BATCH_PRODUCT = "rfidenter.edge.product_id";
	const DEFAULT_ZEBRA_URL = "http://127.0.0.1:18000";
	const BATCH_POLL_INTERVAL_MS = 2000;
	const BATCH_BACKOFF_BASE_MS = 1000;
	const BATCH_BACKOFF_MAX_MS = 30000;

	const state = {
		connMode: String(window.localStorage.getItem(STORAGE_CONN_MODE) || "agent"),
		agentId: String(window.localStorage.getItem(STORAGE_AGENT_ID) || ""),
		agents: [],
		pending: new Map(), // request_id -> {resolve, reject, timeout}
		baseUrl: "",
		status: { ok: false, message: "" },
		config: null,
		devices: [],
		result: null,
		mode: "manual",
		batch: {
			lastEventSeq: null,
			authBlocked: false,
			pollTimer: null,
			pollTimeout: null,
			backoffCount: 0,
			pollMode: "",
		},
	};
	let autoFallbackAllowed = true;
	let autoFallbackTried = false;

	function getAuth() {
		return String(window.localStorage.getItem(STORAGE_AUTH) || "").trim();
	}

	function isZebraAgent(agent) {
		const kind = String(agent?.kind || "").trim().toLowerCase();
		if (kind === "zebra") return true;
		const agentId = String(agent?.agent_id || "").trim().toLowerCase();
		const version = String(agent?.version || "").trim().toLowerCase();
		return agentId.startsWith("zebra") || version.includes("zebra");
	}

	function getSelectedAgentId() {
		return String(state.agentId || "").trim();
	}

	function setSelectedAgentId(agentId) {
		state.agentId = String(agentId || "").trim();
		window.localStorage.setItem(STORAGE_AGENT_ID, state.agentId);
	}

	function getConnMode() {
		const v = String(state.connMode || "").trim().toLowerCase();
		return v === "local" ? "local" : "agent";
	}

	function setConnMode(mode) {
		state.connMode = String(mode || "agent").trim().toLowerCase() === "local" ? "local" : "agent";
		window.localStorage.setItem(STORAGE_CONN_MODE, state.connMode);
	}

	function getBaseUrl() {
		return normalizeBaseUrl(window.localStorage.getItem(STORAGE_ZEBRA_URL) || DEFAULT_ZEBRA_URL) || DEFAULT_ZEBRA_URL;
	}

	function setBaseUrl(url) {
		window.localStorage.setItem(STORAGE_ZEBRA_URL, normalizeBaseUrl(url));
		state.baseUrl = getBaseUrl();
	}

	function loopbackAgentBaseUrl() {
		const agents = Array.isArray(state.agents) ? state.agents : [];
		const selectedId = getSelectedAgentId();
		if (selectedId) {
			const selected = agents.find((a) => String(a?.agent_id || "").trim() === selectedId);
			const urls = Array.isArray(selected?.ui_urls) ? selected.ui_urls : [];
			for (const u of urls) {
				const base = normalizeBaseUrl(u);
				if (base && isLoopbackUrl(base)) return base;
			}
		}
		for (const a of agents) {
			const urls = Array.isArray(a?.ui_urls) ? a.ui_urls : [];
			for (const u of urls) {
				const base = normalizeBaseUrl(u);
				if (base && isLoopbackUrl(base)) return base;
			}
		}
		return "";
	}

	async function trySyncLocalUrlFromAgent({ quiet = false } = {}) {
		try {
			await refreshAgents();
		} catch {
			return false;
		}

		const baseFromAgent = loopbackAgentBaseUrl();
		if (!baseFromAgent) return false;

		const current = getBaseUrl();
		if (normalizeBaseUrl(baseFromAgent) === normalizeBaseUrl(current)) return false;

		setBaseUrl(baseFromAgent);
		try {
			const next = getBaseUrl();
			$url.val(next);
			$open.attr("href", `${next}/`);
		} catch {
			// ignore
		}
		if (!quiet) frappe.show_alert({ message: `Zebra URL yangilandi: ${escapeHtml(baseFromAgent)}`, indicator: "orange" });
		return true;
	}

	async function zebraFetch(path, { method = "GET", body = null, timeoutMs = 15000 } = {}) {
		const baseUrl = state.baseUrl || getBaseUrl();
		const url = `${baseUrl}${path}`;
		const headers = { "content-type": "application/json" };
		const auth = getAuth();
		if (auth) headers.Authorization = auth;

		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
		try {
			const r = await fetch(url, {
				method,
				headers,
				body: body ? JSON.stringify(body) : null,
				signal: controller.signal,
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) {
				const msg = data?.detail || data?.message || `HTTP ${r.status}`;
				throw new Error(msg);
			}
			return data;
		} finally {
			window.clearTimeout(timeout);
		}
	}

	async function refreshAgents() {
		const r = await frappe.call("rfidenter.rfidenter.api.list_agents");
		const msg = r?.message;
		if (!msg || msg.ok !== true) throw new Error("Agentlar olinmadi");
		const agents = Array.isArray(msg.agents) ? msg.agents : [];
		state.agents = agents.filter((a) => isZebraAgent(a));
		return state.agents;
	}

	async function agentCall(command, args, { timeoutMs = 60000 } = {}) {
		const agentId = getSelectedAgentId();
		if (!agentId) throw new Error("Zebra agent tanlang.");

		const timeoutSec = Math.max(2, Math.min(120, Math.ceil(timeoutMs / 1000)));
		const r = await frappe.call("rfidenter.rfidenter.api.agent_enqueue", {
			agent_id: agentId,
			command,
			args: args || {},
			timeout_sec: timeoutSec,
		});

		const msg = r?.message;
		const requestId = String(msg?.request_id || "").trim();
		if (!requestId) throw new Error("request_id olinmadi");

		return await new Promise((resolve, reject) => {
			const timer = window.setTimeout(() => {
				state.pending.delete(requestId);
				reject(new Error("Timeout"));
			}, timeoutMs);

			state.pending.set(requestId, { resolve, reject, timer });

			(async () => {
				for (let i = 0; i < 200; i++) {
					if (!state.pending.has(requestId)) return;
					// eslint-disable-next-line no-await-in-loop
					await sleep(250);
					// eslint-disable-next-line no-await-in-loop
					const rr = await frappe.call("rfidenter.rfidenter.api.agent_result", { request_id: requestId });
					const m = rr?.message;
					if (m?.state === "done") {
						const pending = state.pending.get(requestId);
						if (!pending) return;
						state.pending.delete(requestId);
						window.clearTimeout(pending.timer);
						resolve(m.reply);
						return;
					}
					if (m?.state === "expired") break;
				}
				const pending = state.pending.get(requestId);
				if (!pending) return;
				state.pending.delete(requestId);
				window.clearTimeout(pending.timer);
				reject(new Error("Expired"));
			})().catch((e) => {
				const pending = state.pending.get(requestId);
				if (!pending) return;
				state.pending.delete(requestId);
				window.clearTimeout(pending.timer);
				reject(e);
			});
		});
	}

		async function canReachLocalZebra() {
			try {
				state.baseUrl = getBaseUrl();
				const health = await zebraFetch("/api/v1/health", { timeoutMs: 1500 });
				return Boolean(health?.ok);
			} catch {
				return false;
			}
		}

		async function switchToLocalIfPossible({ quiet = false, message = "" } = {}) {
			const ok = await canReachLocalZebra();
			if (!ok) return false;

			setConnMode("local");
			updateConnectionUi();
			try {
				const baseUrl = getBaseUrl();
				$url.val(baseUrl);
				$open.attr("href", `${baseUrl}/`);
			} catch {
				// ignore
			}
			if (!quiet) {
				frappe.show_alert({ message: message || "Local URL mode ga o‘tildi.", indicator: "orange" });
			}
			autoFallbackAllowed = false;
			await refreshAll({ quiet: true });
			return true;
		}

		async function maybeAutoSwitchToLocal({ quiet = false } = {}) {
			if (!autoFallbackAllowed || autoFallbackTried) return false;
			autoFallbackTried = true;

			return await switchToLocalIfPossible({
				quiet,
				message: "Zebra agent topilmadi — Local URL mode ga o‘tildi.",
			});
		}

		const $body = $(`
			<div class="rfidenter-zebra">
				<style>
					.rfidenter-zebra {
						--rf-card-bg: var(--card-bg, #ffffff);
						--rf-border: var(--border-color, #d1d8dd);
						--rf-muted: var(--text-muted, #6b7280);
						--rf-accent: var(--primary, #3c5a2f);
						--rf-shadow: var(--shadow-sm, 0 6px 16px rgba(0, 0, 0, 0.08));
						font-family: inherit;
						color: var(--text-color, #1f2937);
						background: transparent;
						padding: 8px;
					}
					.rfidenter-zebra,
					.rfidenter-zebra * {
						box-sizing: border-box;
					}
					.rfidenter-zebra .rfz-card {
						background: var(--rf-card-bg);
						border: 1px solid var(--rf-border);
						border-radius: 16px;
						box-shadow: var(--rf-shadow);
						overflow: hidden;
						animation: rfz-fade-up 0.35s ease both;
					}
					.rfidenter-zebra .rfz-card .panel-heading {
						display: flex;
						align-items: center;
						justify-content: space-between;
						gap: 12px;
						flex-wrap: wrap;
						padding: 12px 16px;
						background: transparent;
						border-bottom: 1px solid var(--rf-border);
					}
					.rfidenter-zebra .rfz-card .panel-heading > * {
						min-width: 0;
					}
					.rfidenter-zebra .rfz-card .panel-body {
						padding: 16px;
					}
					.rfidenter-zebra .rfz-card-title {
						display: inline-flex;
						align-items: center;
						gap: 8px;
						font-weight: 700;
						font-size: 15px;
						line-height: 1.2;
						letter-spacing: 0.2px;
					}
					.rfidenter-zebra .rfz-card-title .rfz-icon {
						width: 26px;
						height: 26px;
						display: inline-flex;
						align-items: center;
						justify-content: center;
						border-radius: 9px;
						background: var(--control-bg, var(--rf-card-bg));
						color: inherit;
						border: 1px solid var(--rf-border);
						flex: 0 0 auto;
					}
					.rfidenter-zebra .rfz-card-title .rfz-icon i {
						position: static !important;
						margin: 0;
					}
					.rfidenter-zebra .rfz-pill {
						display: inline-flex;
						align-items: center;
						gap: 6px;
						padding: 6px 12px;
						border-radius: 999px;
						font-size: 11px;
						font-weight: 700;
						letter-spacing: 0.2px;
						background: var(--control-bg, var(--rf-card-bg));
						color: inherit;
						border: 1px solid var(--rf-border);
					}
					.rfidenter-zebra .rfidenter-zebra-status {
						background: var(--control-bg, var(--rf-card-bg));
						color: inherit;
						border: 1px solid var(--rf-border);
					}
					.rfidenter-zebra .form-control {
						border-radius: 12px;
						border: 1px solid var(--control-border-color, var(--rf-border));
						background: var(--control-bg, var(--rf-card-bg));
						box-shadow: none;
						transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
					}
					.rfidenter-zebra .form-control:focus {
						border-color: var(--control-border-color, var(--rf-border));
						box-shadow: none;
					}
					.rfidenter-zebra label {
						font-size: 11px;
						font-weight: 700;
						letter-spacing: 0.08em;
						text-transform: uppercase;
						color: var(--rf-muted);
					}
					.rfidenter-zebra .rfz-control .help-box,
					.rfidenter-zebra .rfz-control .help-block,
					.rfidenter-zebra .rfz-control .control-help {
						display: none !important;
					}
					.rfidenter-zebra .rfz-control .form-group {
						margin-bottom: 0;
					}
					.rfidenter-zebra .rfz-form-row {
						margin: 0 -8px;
					}
					.rfidenter-zebra .rfz-form-row > div {
						padding: 0 8px;
					}
					.rfidenter-zebra .rfz-conn-row {
						display: flex;
						align-items: center;
						gap: 12px;
						flex-wrap: wrap;
					}
					.rfidenter-zebra .rfz-conn-row > * {
						min-width: 0;
					}
					.rfidenter-zebra .rfidenter-conn-agent,
					.rfidenter-zebra .rfidenter-conn-local {
						flex: 1 1 360px;
						min-width: 240px;
					}
					.rfidenter-zebra .rfidenter-agent,
					.rfidenter-zebra .rfidenter-zebra-url {
						width: 100% !important;
						max-width: 520px;
					}
					.rfidenter-zebra .rfz-actions {
						display: flex;
						align-items: center;
						gap: 10px;
						flex-wrap: wrap;
						background: transparent;
						border: 1px solid var(--rf-border);
						border-radius: 16px;
						padding: 8px;
					}
					.rfidenter-zebra .rfz-actions .btn {
						border-radius: 999px;
						padding: 7px 16px;
						border: 1px solid var(--rf-border);
						box-shadow: none;
						transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
					}
					.rfidenter-zebra .rfz-actions .btn:hover {
						transform: translateY(-1px);
						box-shadow: none;
					}
					.rfidenter-zebra .rfz-actions .btn i {
						margin-right: 6px;
					}
					.rfidenter-zebra .rfz-actions .rfz-pill {
						padding: 6px 10px;
						white-space: nowrap;
					}
					.rfidenter-zebra .rfz-batch-grid {
						display: flex;
						flex-wrap: wrap;
						gap: 12px 18px;
					}
					.rfidenter-zebra .rfz-batch-field {
						min-width: 140px;
					}
					.rfidenter-zebra .rfz-batch-value {
						font-weight: 600;
					}
					.rfidenter-zebra .rfz-queue:empty { display: none; }
					.rfidenter-zebra .rfz-status:empty { display: none; }
					.rfidenter-zebra .rfz-batch-status:empty,
					.rfidenter-zebra .rfz-device-status:empty { display: none; }
					.rfidenter-zebra .rfz-scale {
						display: flex;
						align-items: center;
						justify-content: space-between;
						gap: 12px;
						padding: 10px 12px;
						border: 1px solid var(--rf-border);
						border-radius: 16px;
						background: var(--control-bg, var(--rf-card-bg));
					}
					.rfidenter-zebra .rfz-scale-left {
						display: flex;
						align-items: center;
						gap: 10px;
					}
					.rfidenter-zebra .rfz-scale-icon {
						width: 40px;
						height: 40px;
						border-radius: 12px;
						display: flex;
						align-items: center;
						justify-content: center;
						background: var(--control-bg, var(--rf-card-bg));
						border: 1px solid var(--rf-border);
						color: inherit;
					}
					.rfidenter-zebra .rfz-table {
						margin-top: 12px;
						max-height: 320px;
						overflow: auto;
						border: 1px solid var(--rf-border);
						border-radius: 16px;
						background: var(--rf-card-bg);
					}
					.rfidenter-zebra .rfz-table table {
						margin: 0;
					}
					.rfidenter-zebra .rfz-table th,
					.rfidenter-zebra .rfz-table td {
						vertical-align: middle;
						font-size: 13px;
					}
					.rfidenter-zebra .rfz-table thead th {
						background: var(--table-header-bg, var(--control-bg, transparent));
						font-weight: 700;
					}
					.rfidenter-zebra .rfz-scale-value {
						font-weight: 600;
						font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New",
							monospace;
						font-size: 18px;
					}
					.rfidenter-zebra .rfz-scale-meta {
						font-size: 12px;
						color: var(--rf-muted);
					}
					.rfidenter-zebra details.rfz-advanced > summary {
						cursor: pointer;
						user-select: none;
						color: var(--rf-muted);
						margin-top: 12px;
					}
					.rfidenter-zebra details.rfz-advanced[open] > summary {
						margin-bottom: 12px;
					}
					@keyframes rfz-fade-up {
						from { opacity: 0; transform: translateY(8px); }
						to { opacity: 1; transform: translateY(0); }
					}
					@media (max-width: 980px) {
						.rfidenter-zebra {
							padding: 8px;
						}
						.rfidenter-zebra .rfz-card .panel-heading,
						.rfidenter-zebra .rfz-card .panel-body {
							padding: 12px;
						}
						.rfidenter-zebra .rfidenter-conn-agent,
						.rfidenter-zebra .rfidenter-conn-local {
							min-width: 200px;
						}
					}
				</style>

				<div class="panel panel-default rfz-card">
					<div class="panel-heading">
						<div class="rfz-card-title"><span class="rfz-icon"><i class="fa fa-plug"></i></span> Ulanish</div>
						<span class="rfz-pill orange rfidenter-zebra-status">Tekshirilmoqda...</span>
					</div>
					<div class="panel-body">
					<div class="flex rfz-conn-row" style="gap: 10px; align-items: center; flex-wrap: wrap">
						<select class="form-control input-sm rfidenter-conn-mode" style="width: 200px">
							<option value="agent">Agent</option>
							<option value="local">Local URL</option>
						</select>

						<div class="rfidenter-conn-agent flex" style="gap: 10px; align-items: center; flex-wrap: wrap">
							<select class="form-control input-sm rfidenter-agent" style="width: 360px"></select>
							<button class="btn btn-default btn-sm rfidenter-agent-refresh"><i class="fa fa-refresh"></i></button>
							<span class="text-muted rfidenter-agent-hint"></span>
						</div>

						<div class="rfidenter-conn-local flex" style="gap: 10px; align-items: center; flex-wrap: wrap">
							<input class="form-control input-sm rfidenter-zebra-url" style="width: 360px" placeholder="http://127.0.0.1:18000" />
							<button class="btn btn-default btn-sm rfidenter-zebra-refresh"><i class="fa fa-refresh"></i></button>
						</div>

						<a class="btn btn-default btn-sm rfidenter-zebra-open" target="_blank" rel="noopener noreferrer"><i class="fa fa-external-link"></i> UI</a>
				</div>
				</div>
			</div>

				<div class="panel panel-default rfz-card" style="margin-top: 12px">
					<div class="panel-heading">
						<div class="rfz-card-title"><span class="rfz-icon"><i class="fa fa-sitemap"></i></span> Batch Control</div>
						<span class="rfz-pill rfz-batch-state">Stopped</span>
					</div>
					<div class="panel-body">
						<div class="row rfz-form-row">
							<div class="col-md-4 rfz-control">
								<label class="text-muted">Device ID</label>
								<input class="form-control input-sm rfz-device-id" placeholder="EDGE-001" />
							</div>
							<div class="col-md-4 rfz-control">
								<label class="text-muted">Batch ID</label>
								<input class="form-control input-sm rfz-batch-id" placeholder="BATCH-001" />
							</div>
							<div class="col-md-4 rfz-control">
								<label class="text-muted">Product</label>
								<div class="rfz-batch-product"></div>
							</div>
						</div>

						<div class="rfz-actions" style="margin-top: 12px">
							<button class="btn btn-primary btn-sm rfz-batch-start"><i class="fa fa-play"></i> Start</button>
							<button class="btn btn-default btn-sm rfz-batch-stop"><i class="fa fa-stop"></i> Stop</button>
							<button class="btn btn-default btn-sm rfz-batch-switch"><i class="fa fa-exchange"></i> Switch Product</button>
							<span class="rfz-pill rfz-batch-status"></span>
							<span class="rfz-pill rfz-device-status"></span>
						</div>
						<div class="alert alert-danger rfz-auth-banner" style="display:none; margin-top: 10px">
							Auth required
						</div>

						<div class="rfz-batch-grid" style="margin-top: 12px">
							<div class="rfz-batch-field">
								<div class="text-muted">Last seen</div>
								<div class="rfz-batch-value rfz-last-seen">--</div>
							</div>
							<div class="rfz-batch-field">
								<div class="text-muted">Last seq</div>
								<div class="rfz-batch-value rfz-last-seq">--</div>
							</div>
							<div class="rfz-batch-field">
								<div class="text-muted">Current batch</div>
								<div class="rfz-batch-value rfz-current-batch">--</div>
							</div>
							<div class="rfz-batch-field">
								<div class="text-muted">Current product</div>
								<div class="rfz-batch-value rfz-current-product">--</div>
							</div>
							<div class="rfz-batch-field">
								<div class="text-muted">Pending product</div>
								<div class="rfz-batch-value rfz-pending-product">--</div>
							</div>
						</div>

						<div class="rfz-batch-grid" style="margin-top: 12px">
							<div class="rfz-batch-field">
								<div class="text-muted">Print queue</div>
								<div class="rfz-batch-value rfz-queue-print">N/A</div>
							</div>
							<div class="rfz-batch-field">
								<div class="text-muted">ERP queue</div>
								<div class="rfz-batch-value rfz-queue-erp">N/A</div>
							</div>
							<div class="rfz-batch-field">
								<div class="text-muted">Agent queue</div>
								<div class="rfz-batch-value rfz-queue-agent">N/A</div>
							</div>
						</div>
					</div>
				</div>

				<details class="rfz-advanced">
					<summary>Advanced / Fallback</summary>

				<div class="panel panel-default rfz-card" style="margin-top: 12px">
					<div class="panel-heading">
						<div class="rfz-card-title"><span class="rfz-icon"><i class="fa fa-tag"></i></span> Manual Print (Fallback)</div>
						<button class="btn btn-default btn-xs rfz-open-settings" title="Item receipt settings">
							<i class="fa fa-gear"></i>
						</button>
					</div>
					<div class="panel-body">
						<div class="row rfz-form-row">
							<div class="col-md-6 rfz-control">
								<label class="text-muted">Kategoriya</label>
								<div class="rfz-item-group"></div>
							</div>
							<div class="col-md-6 rfz-control">
								<label class="text-muted">Mahsulot</label>
								<div class="rfz-item"></div>
							</div>
						</div>

						<div class="row rfz-form-row" style="margin-top: 10px">
							<div class="col-md-3 rfz-control">
								<label class="text-muted">Qty</label>
								<div class="rfz-qty"></div>
							</div>
							<div class="col-md-3 rfz-control">
								<label class="text-muted">UOM</label>
								<div class="rfz-uom"></div>
							</div>
							<div class="col-md-3 rfz-control">
								<label class="text-muted">Antenna</label>
								<div class="rfz-ant"></div>
							</div>
								<div class="col-md-3">
									<div class="rfz-actions" style="margin-top: 18px">
										<button class="btn btn-primary btn-sm rfz-print"><i class="fa fa-bolt"></i> Print</button>
										<button class="btn btn-default btn-sm rfz-read-epc" title="Tag EPC o‘qish"><i class="fa fa-eye"></i></button>
										<button class="btn btn-default btn-sm rfz-stop" title="Navbatni to‘xtatish"><i class="fa fa-stop"></i></button>
										<button class="btn btn-default btn-sm rfz-calibrate" title="Kalibratsiya"><i class="fa fa-sliders"></i></button>
										<span class="rfz-pill rfz-status"></span>
									</div>
								</div>
							</div>

						<div class="row rfz-form-row" style="margin-top: 6px">
							<div class="col-md-12">
								<div class="rfz-scale">
									<div class="rfz-scale-left">
										<span class="rfz-scale-icon"><i class="fa fa-balance-scale"></i></span>
										<div>
											<div class="rfz-scale-value">--</div>
											<div class="rfz-scale-meta">Ulanmagan</div>
										</div>
									</div>
									<label class="checkbox-inline rfz-scale-autofill" style="margin: 0">
										<input type="checkbox" checked /> Auto Qty/UOM
									</label>
								</div>
							</div>
						</div>

						<div class="rfz-table table-responsive">
							<table class="table table-bordered table-hover">
								<thead>
									<tr>
										<th style="width: 44px">#</th>
										<th style="width: 260px">EPC</th>
										<th>Item</th>
										<th style="width: 90px">Qty</th>
										<th style="width: 80px">UOM</th>
											<th style="width: 70px">ANT</th>
											<th style="width: 120px">Status</th>
											<th style="width: 160px">Stock Entry</th>
											<th style="width: 90px">Action</th>
										</tr>
									</thead>
									<tbody class="rfz-recent"></tbody>
								</table>
						</div>
					</div>
				</div>

					<div class="panel panel-default rfz-card" style="margin-top: 12px">
						<div class="panel-heading"><div class="rfz-card-title"><span class="rfz-icon"><i class="fa fa-print"></i></span> Printer</div></div>
						<div class="panel-body">
							<div class="text-muted" style="margin-bottom: 8px">Config: <code class="rfidenter-zebra-config"></code></div>
							<div class="table-responsive">
								<table class="table table-bordered table-hover">
									<thead>
										<tr>
											<th style="width: 180px">USB</th>
											<th>Info</th>
										</tr>
									</thead>
									<tbody class="rfidenter-zebra-devices"></tbody>
								</table>
							</div>
						</div>
					</div>

					<div class="panel panel-default rfz-card" style="margin-top: 12px">
						<div class="panel-heading"><div class="rfz-card-title"><span class="rfz-icon"><i class="fa fa-qrcode"></i></span> Encode</div></div>
						<div class="panel-body">
					<div class="flex" style="gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 12px">
						<label class="radio-inline" style="margin: 0">
							<input type="radio" name="rfidenter-zebra-mode" value="manual" checked />
							Manual
						</label>
						<label class="radio-inline" style="margin: 0">
							<input type="radio" name="rfidenter-zebra-mode" value="auto" />
							Auto (unique)
						</label>

						<button class="btn btn-default btn-sm rfidenter-zebra-feed" style="margin-left: auto">
							<i class="fa fa-forward"></i> Feed
						</button>
					</div>

					<div class="rfidenter-mode-manual">
						<div class="form-group">
							<label>EPC (hex)</label>
							<input class="form-control input-sm rfidenter-epc" placeholder="3034257BF7194E4000000001" />
						</div>

						<div class="flex" style="gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px">
							<label class="checkbox-inline" style="margin: 0">
								<input type="checkbox" class="rfidenter-copies-enabled" />
								Copies (repeat same EPC)
							</label>
							<div class="flex" style="gap: 8px; align-items: center">
								<label class="text-muted" style="margin: 0">Count</label>
								<input class="form-control input-sm rfidenter-copies" style="width: 120px" value="2" readonly />
							</div>
						</div>
					</div>

					<div class="rfidenter-mode-auto" style="display:none">
						<div class="form-group">
							<label>Count (unique EPCs)</label>
							<input class="form-control input-sm rfidenter-auto-count" style="width: 220px" value="1" />
						</div>
					</div>

					<div class="flex" style="gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px">
						<label class="checkbox-inline" style="margin: 0">
							<input type="checkbox" class="rfidenter-print-text" />
							Print EPC text
						</label>
						<label class="checkbox-inline" style="margin: 0">
							<input type="checkbox" class="rfidenter-feed-after" />
							Feed after encode (encode-only)
						</label>
					</div>

					<button class="btn btn-primary btn-sm rfidenter-zebra-write">
						<i class="fa fa-bolt"></i> Write
					</button>
					<span class="text-muted rfidenter-write-status" style="margin-left: 8px"></span>

					<div class="rfidenter-result-wrap" style="margin-top: 12px; display:none">
						<div class="alert rfidenter-result-alert" style="margin-bottom: 10px"></div>
						<div class="table-responsive">
							<table class="table table-bordered table-hover">
								<thead>
									<tr>
										<th style="width: 44px">#</th>
										<th>EPC</th>
										<th style="width: 90px">Copies</th>
										<th style="width: 110px">Status</th>
										<th>Message</th>
									</tr>
								</thead>
								<tbody class="rfidenter-result-tbody"></tbody>
							</table>
						</div>

						<div class="flex" style="gap: 10px; align-items:center">
							<button class="btn btn-default btn-sm rfidenter-copy-epcs">Copy EPC list</button>
							<span class="text-muted rfidenter-copy-status"></span>
							<textarea class="rfidenter-epc-list" style="position:absolute; left:-9999px; top:-9999px" readonly></textarea>
						</div>
					</div>
					</div>
				</div>
				</details>
		</div>
	`);

	page.main.append($body);

	const $connMode = $body.find(".rfidenter-conn-mode");
	const $connAgent = $body.find(".rfidenter-agent");
	const $connAgentHint = $body.find(".rfidenter-agent-hint");
	const $connAgentWrap = $body.find(".rfidenter-conn-agent");
	const $connLocalWrap = $body.find(".rfidenter-conn-local");
	const $url = $body.find(".rfidenter-zebra-url");
	const $open = $body.find(".rfidenter-zebra-open");
	const $status = $body.find(".rfidenter-zebra-status");
	const $cfg = $body.find(".rfidenter-zebra-config");
	const $devices = $body.find(".rfidenter-zebra-devices");
	const $batchDevice = $body.find(".rfz-device-id");
	const $batchId = $body.find(".rfz-batch-id");
	const $batchProductWrap = $body.find(".rfz-batch-product");
	const $batchStart = $body.find(".rfz-batch-start");
	const $batchStop = $body.find(".rfz-batch-stop");
	const $batchSwitch = $body.find(".rfz-batch-switch");
	const $batchState = $body.find(".rfz-batch-state");
	const $batchStatus = $body.find(".rfz-batch-status");
	const $batchDeviceStatus = $body.find(".rfz-device-status");
	const $authBanner = $body.find(".rfz-auth-banner");
	const $batchLastSeen = $body.find(".rfz-last-seen");
	const $batchLastSeq = $body.find(".rfz-last-seq");
	const $batchCurrentBatch = $body.find(".rfz-current-batch");
	const $batchCurrentProduct = $body.find(".rfz-current-product");
	const $batchPendingProduct = $body.find(".rfz-pending-product");
	const $batchQueuePrint = $body.find(".rfz-queue-print");
	const $batchQueueErp = $body.find(".rfz-queue-erp");
	const $batchQueueAgent = $body.find(".rfz-queue-agent");
	const $modeManual = $body.find(".rfidenter-mode-manual");
	const $modeAuto = $body.find(".rfidenter-mode-auto");
	const $epc = $body.find(".rfidenter-epc");
	const $copiesEnabled = $body.find(".rfidenter-copies-enabled");
	const $copies = $body.find(".rfidenter-copies");
	const $autoCount = $body.find(".rfidenter-auto-count");
	const $printText = $body.find(".rfidenter-print-text");
	const $feedAfter = $body.find(".rfidenter-feed-after");
	const $write = $body.find(".rfidenter-zebra-write");
	const $writeStatus = $body.find(".rfidenter-write-status");
	const $resultWrap = $body.find(".rfidenter-result-wrap");
	const $resultAlert = $body.find(".rfidenter-result-alert");
	const $resultBody = $body.find(".rfidenter-result-tbody");
		const $copyBtn = $body.find(".rfidenter-copy-epcs");
		const $copyStatus = $body.find(".rfidenter-copy-status");
		const $epcList = $body.find(".rfidenter-epc-list");
		const $itemGroupWrap = $body.find(".rfz-item-group");
		const $itemWrap = $body.find(".rfz-item");
		const $qtyWrap = $body.find(".rfz-qty");
			const $uomWrap = $body.find(".rfz-uom");
			const $antWrap = $body.find(".rfz-ant");
			const $scaleValue = $body.find(".rfz-scale-value");
			const $scaleMeta = $body.find(".rfz-scale-meta");
			const $scaleAutofill = $body.find(".rfz-scale-autofill input");
			const $itemPrint = $body.find(".rfz-print");
			const $itemReadEpc = $body.find(".rfz-read-epc");
			const $itemStop = $body.find(".rfz-stop");
			const $itemCalibrate = $body.find(".rfz-calibrate");
			const $itemStatus = $body.find(".rfz-status");
			const $itemQueue = $body.find(".rfz-queue");
			const $itemRecentBody = $body.find(".rfz-recent");

			const STORAGE_ITEM_QUEUE = "rfidenter.zebra.item_queue.v1";
			const STORAGE_SCALE_AUTOFILL = "rfidenter.scale.autofill";

		const itemState = {
			controlsReady: false,
			processing: false,
			timer: null,
			itemStockUom: "",
			controls: { item_group: null, item: null, qty: null, uom: null, ant: null },
		};
		const scaleState = {
			lastWeight: null,
			lastUnit: "",
			lastStable: null,
			lastTs: 0,
			timer: null,
		};
		const batchControl = { product: null };

		function getDeviceId() {
			const raw = String($batchDevice.val() || "").trim();
			if (raw) return raw;
			const stored = String(window.localStorage.getItem(STORAGE_DEVICE_ID) || "").trim();
			if (stored && $batchDevice.length) $batchDevice.val(stored);
			return stored;
		}

		function setDeviceId(value) {
			const v = String(value || "").trim();
			window.localStorage.setItem(STORAGE_DEVICE_ID, v);
			if ($batchDevice.length) $batchDevice.val(v);
		}

		function getBatchId() {
			const raw = String($batchId.val() || "").trim();
			if (raw) return raw;
			const stored = String(window.localStorage.getItem(STORAGE_BATCH_ID) || "").trim();
			if (stored && $batchId.length) $batchId.val(stored);
			return stored;
		}

		function setBatchId(value) {
			const v = String(value || "").trim();
			window.localStorage.setItem(STORAGE_BATCH_ID, v);
			if ($batchId.length) $batchId.val(v);
		}

		function getBatchProduct() {
			const raw = String(batchControl.product?.get_value?.() || "").trim();
			if (raw) return raw;
			const stored = String(window.localStorage.getItem(STORAGE_BATCH_PRODUCT) || "").trim();
			if (stored && batchControl.product) batchControl.product.set_value(stored);
			return stored;
		}

		function setBatchProduct(value) {
			const v = String(value || "").trim();
			window.localStorage.setItem(STORAGE_BATCH_PRODUCT, v);
			if (batchControl.product) batchControl.product.set_value(v);
		}

		function sanitizeZplText(value) {
			const s = String(value ?? "").trim();
			if (!s) return "";
			// Avoid ZPL control characters inside ^FD ... ^FS.
			return s.replaceAll("^", " ").replaceAll("~", " ").replace(/\s+/g, " ").trim().slice(0, 80);
		}

		function scaleAutofillEnabled() {
			const raw = String(window.localStorage.getItem(STORAGE_SCALE_AUTOFILL) || "").trim().toLowerCase();
			if (!raw) return true;
			return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
		}

		function setScaleAutofill(value) {
			window.localStorage.setItem(STORAGE_SCALE_AUTOFILL, value ? "1" : "0");
		}

		function normalizeScaleUnit(raw) {
			const s = String(raw || "").trim().toLowerCase();
			if (!s) return "";
			if (["kg", "kgs", "kilogram", "kilograms"].includes(s)) return "kg";
			if (["g", "gram", "grams"].includes(s)) return "g";
			if (["lb", "lbs", "pound", "pounds"].includes(s)) return "lb";
			if (["oz", "ounce", "ounces"].includes(s)) return "oz";
			return s;
		}

		function mapScaleUnitToUom(unit) {
			const s = normalizeScaleUnit(unit);
			const map = { kg: "Kg", g: "Gram", lb: "Pound", oz: "Ounce" };
			return map[s] || "";
		}

		function isKgUom(raw) {
			const s = String(raw || "").trim().toLowerCase();
			if (!s) return false;
			return s === "kg" || s === "kgs" || s === "kilogram" || s === "kilograms";
		}

		function formatScaleWeight(weight, unit) {
			if (!Number.isFinite(weight)) return "--";
			const val = Number(weight).toFixed(3);
			const u = String(unit || "").trim();
			return u ? `${val} ${u}` : val;
		}

		function formatScaleAge(ts) {
			const n = Number(ts);
			if (!Number.isFinite(n) || n <= 0) return "";
			const delta = Date.now() - n;
			if (delta < 1000) return "hozir";
			if (delta < 60000) return `${Math.floor(delta / 1000)}s oldin`;
			if (delta < 3600000) return `${Math.floor(delta / 60000)}m oldin`;
			return fmtTime(n);
		}

		function parseScalePayload(payload) {
			const data = payload?.reading || payload;
			if (!data) return null;
			const weight = Number(data.weight);
			if (!Number.isFinite(weight)) return null;
			const unit = normalizeScaleUnit(data.unit || "kg");
			const stableRaw = data.stable;
			const stable = stableRaw === true ? true : stableRaw === false ? false : null;
			const ts = Number(data.ts || data.ts_ms || data.timestampMs || data.timestamp_ms || 0);
			const port = String(data.port || "").trim();
			const device = String(data.device || "").trim();
			return { weight, unit, stable, ts, port, device };
		}

		function updateScaleUi(payload, { error = "" } = {}) {
			if (!$scaleValue.length || !$scaleMeta.length) return;
			if (!payload) {
				$scaleValue.text("--");
				$scaleMeta.text(error ? `Xato: ${error}` : "Ulanmagan");
				return;
			}
			$scaleValue.text(formatScaleWeight(payload.weight, payload.unit));
			const bits = [];
			if (payload.port) bits.push(payload.port);
			if (payload.stable === true) bits.push("stable");
			if (payload.stable === false) bits.push("unstable");
			const age = formatScaleAge(payload.ts);
			if (age) bits.push(age);
			$scaleMeta.text(bits.join(" · "));
		}

		function applyScaleToControls(payload) {
			if (!payload) return;
			if (!$scaleAutofill.length || !$scaleAutofill.is(":checked")) return;
			if (!itemState.controlsReady) return;
			if (!Number.isFinite(payload.weight)) return;
			if (payload.stable === false) return;
			if (!isKgUom(itemState.itemStockUom)) return;

			const qtyControl = itemState.controls.qty;
			const uomControl = itemState.controls.uom;
			try {
				const qtyInput = qtyControl?.$input;
				if (qtyInput && qtyInput.is(":focus")) return;
			} catch {
				// ignore
			}

			qtyControl?.set_value?.(payload.weight);
			const uom = mapScaleUnitToUom(payload.unit);
			if (uom) {
				uomControl?.set_value?.(uom);
			}
		}

		function handleScalePayload(payload) {
			const parsed = parseScalePayload(payload);
			if (!parsed) return;
			scaleState.lastWeight = parsed.weight;
			scaleState.lastUnit = parsed.unit;
			scaleState.lastStable = parsed.stable;
			scaleState.lastTs = parsed.ts || Date.now();
			updateScaleUi(parsed);
			applyScaleToControls(parsed);
		}

		async function refreshScaleOnce({ quiet = false } = {}) {
			const connMode = getConnMode();
			if (connMode === "local") {
				try {
					const data = await zebraFetch("/api/v1/scale", { timeoutMs: 1500 });
					if (!data || data.ok === false) {
						if (!quiet) updateScaleUi(null, { error: data?.error || "" });
						return;
					}
					handleScalePayload(data);
					return;
				} catch (e) {
					if (!quiet) updateScaleUi(null, { error: e?.message || e });
					// fall through to ERP fallback
				}
			}

			try {
				const r = await frappe.call("rfidenter.rfidenter.api.get_scale_weight");
				const msg = r?.message;
				if (!msg || msg.ok !== true) {
					if (!quiet) updateScaleUi(null, { error: msg?.error || "" });
					return;
				}
				handleScalePayload(msg.reading || msg);
			} catch (e) {
				if (!quiet) updateScaleUi(null, { error: e?.message || e });
			}
		}

		function loadItemQueue() {
			try {
				const raw = window.localStorage.getItem(STORAGE_ITEM_QUEUE);
				const arr = raw ? JSON.parse(raw) : [];
				return Array.isArray(arr) ? arr : [];
			} catch {
				return [];
			}
		}

			function saveItemQueue(queue) {
				try {
					window.localStorage.setItem(STORAGE_ITEM_QUEUE, JSON.stringify(Array.isArray(queue) ? queue : []));
				} catch {
					// ignore
				}
			}

			function renderItemQueue() {
				if (!$itemQueue.length) return;
				const q = loadItemQueue();
				const pending = q.filter((j) => j && j.state !== "done").length;
				$itemQueue.text(pending ? `Queue: ${pending}` : "");
			}

			function newClientRequestId() {
				const rnd = Math.random().toString(16).slice(2, 10);
				return `rfz-${Date.now()}-${rnd}`;
			}

				$itemRecentBody.on("click", ".rfz-reprint", (e) => {
					const $btn = $(e.currentTarget);
					const epc = normalizeEpcHex($btn.data("epc"));
					if (!epc) return;

				const itemCode = String($btn.data("itemCode") || "").trim();
				const itemName = String($btn.data("itemName") || "").trim();
					const qty = Number($btn.data("qty") || 1);
					const uom = String($btn.data("uom") || "").trim();
					const consumeAntId = clampInt($btn.data("consumeAntId"), { min: 0, max: 31, fallback: 0 });

					const queue = loadItemQueue();
					queue.unshift({
						client_request_id: newClientRequestId(),
						state: "print",
						epc,
						tag: { item_code: itemCode, item_name: itemName, qty, uom, consume_ant_id: consumeAntId },
						created_at: Date.now(),
						tries: 0,
						last_error: "",
					});
					saveItemQueue(queue);
					renderItemQueue();
					setItemStatus(`Navbatga qo‘shildi: ${epc}`, { indicator: "gray" });
					processItemQueue().catch(() => {});
				});

				const HV_CURRENT_EPC = "RFZ_CURRENT_EPC:";
				const HV_BEFORE_EPC = "RFZ_BEFORE_EPC:";
				const HV_AFTER_EPC = "RFZ_AFTER_EPC:";

				function extractEpcFromHv(output, marker) {
					const text = String(output ?? "");
					const m = String(marker ?? "");
					if (!text || !m) return "";

					const idx = text.toUpperCase().indexOf(m.toUpperCase());
					if (idx < 0) return "";

					let i = idx + m.length;
					let hex = "";
					while (i < text.length && hex.length < 128) {
						const ch = text[i];
						if (/[0-9A-F]/i.test(ch)) hex += String(ch).toUpperCase();
						i++;
					}
					return hex.length >= 24 ? hex.slice(-24) : "";
				}

				function hasHvMarker(output, marker) {
					const text = String(output ?? "");
					const m = String(marker ?? "");
					if (!text || !m) return false;
					return text.toUpperCase().includes(m.toUpperCase());
				}

				function buildRfidReadEpcHv({ fn, header }) {
					const n = clampInt(fn, { min: 1, max: 99, fallback: 1 });
					const h = sanitizeZplText(header);
					// Read EPC bank from start (includes CRC+PC+EPC); ERP extracts the last 96-bit EPC (24 hex chars).
					return [`^RFR,H,0,16,1^FN${n}^FS`, `^HV${n},,${h}^FS`];
				}

				function buildReadCurrentEpcZpl() {
					return ["^XA", "^RS8,,,1,N", ...buildRfidReadEpcHv({ fn: 1, header: HV_CURRENT_EPC }), "^PQ1", "^XZ"]
						.filter(Boolean)
						.join("\n");
				}

				function isTransceiveUnsupportedError(err) {
					const msg = String(err?.message || err || "")
						.trim()
						.toLowerCase();
					return (
						msg.includes("unknown command") ||
						msg.includes("does not support reading") ||
						msg.includes("failed to open") ||
						msg.includes("failed to read") ||
						msg.includes("bulk in endpoint not found") ||
						msg.includes("unset zebra_device_path")
					);
				}

				async function zebraTransceiveZpl(zpl, { readTimeoutMs = 3000, maxBytes = 32768, timeoutMs = 60000 } = {}) {
					let connMode = getConnMode();
					if (connMode === "agent" && !getSelectedAgentId()) {
						await switchToLocalIfPossible({ quiet: true });
						connMode = getConnMode();
					}

					if (connMode === "agent") {
						const reply = await agentCall(
							"ZEBRA_TRANSCEIVE_ZPL",
							{ zpl, read_timeout_ms: readTimeoutMs, max_bytes: maxBytes },
							{ timeoutMs }
						);
						if (!reply?.ok) throw new Error(reply?.error || "Transceive failed");
						return reply.result;
					}

					return await zebraFetch("/api/v1/transceive", {
						method: "POST",
						body: { zpl, read_timeout_ms: readTimeoutMs, max_bytes: maxBytes },
						timeoutMs,
					});
				}

				async function zebraSendZpl(zpl, { timeoutMs = 30000 } = {}) {
					let connMode = getConnMode();
					if (connMode === "agent" && !getSelectedAgentId()) {
						await switchToLocalIfPossible({ quiet: true });
						connMode = getConnMode();
					}

					if (connMode === "agent") {
						const reply = await agentCall("ZEBRA_PRINT_ZPL", { zpl, copies: 1 }, { timeoutMs });
						if (!reply?.ok) throw new Error(reply?.error || "Print failed");
						return reply.result;
					}

					return await zebraFetch("/v1/print-jobs", { method: "POST", body: { zpl, copies: 1 }, timeoutMs });
				}

				function buildItemZpl({ epc, itemCode, itemName, qty, uom, verifyEpc = false }) {
					const line1 = sanitizeZplText(itemCode);
					const line2 = sanitizeZplText(itemName);
					const line3 = sanitizeZplText(`${qty} ${uom}`);
					const line4 = sanitizeZplText(epc);

					// Simple label: encode EPC + print item info.
					// `^RFW,H,,,A` auto-adjusts PC bits for EPC bank writes.
					const lines = ["^XA", "^RS8,,,1,N"];
					if (verifyEpc) lines.push(...buildRfidReadEpcHv({ fn: 1, header: HV_BEFORE_EPC }));
					lines.push(`^RFW,H,,,A^FD${epc}^FS`);
					if (verifyEpc) lines.push(...buildRfidReadEpcHv({ fn: 2, header: HV_AFTER_EPC }));
					lines.push(
						line1 ? `^FO30,30^A0N,34,34^FD${line1}^FS` : "",
						line2 ? `^FO30,70^A0N,28,28^FD${line2}^FS` : "",
						line3 ? `^FO30,110^A0N,34,34^FD${line3}^FS` : "",
						line4 ? `^FO30,155^A0N,22,22^FD${line4}^FS` : "",
						"^PQ1",
						"^XZ"
					);
					return lines.filter(Boolean).join("\n");
			}

		function setItemStatus(text, { indicator = "gray" } = {}) {
			$itemStatus.text(String(text || ""));
			const map = { gray: "#6b7280", green: "#1f7a1f", red: "#a33", orange: "#b45309" };
			$itemStatus.css("color", map[indicator] || map.gray);
		}

		async function refreshRecentTags({ quiet = false } = {}) {
			try {
				const r = await frappe.call("rfidenter.rfidenter.api.zebra_list_tags", { limit: 30 });
				const msg = r?.message;
				if (!msg || msg.ok !== true) throw new Error("Ro‘yxat olinmadi");
				const items = Array.isArray(msg.items) ? msg.items : [];
				renderRecentTags(items);
				if (!quiet) setItemStatus("Yangilandi", { indicator: "green" });
			} catch (e) {
				if (!quiet) setItemStatus(`Xato: ${e?.message || e}`, { indicator: "orange" });
			}
		}

			function renderRecentTags(items) {
				$itemRecentBody.empty();
				if (!items.length) {
					$itemRecentBody.append(`<tr><td colspan="9" class="text-muted">(yo‘q)</td></tr>`);
					return;
				}
				for (let i = 0; i < items.length; i++) {
					const it = items[i] || {};
					const epcRaw = String(it.epc || "");
					const itemCodeRaw = String(it.item_code || "");
					const itemNameRaw = String(it.item_name || "");
					const uomRaw = String(it.uom || "");
					const antRaw = String(it.consume_ant_id ?? "");
					const statusRaw = String(it.status || "");

					const epc = escapeHtml(epcRaw);
					const item = escapeHtml(itemCodeRaw);
					const name = escapeHtml(itemNameRaw);
					const qty = escapeHtml(it.qty ?? "");
					const uom = escapeHtml(uomRaw);
					const ant = escapeHtml(antRaw);
					const st = escapeHtml(statusRaw);
					const err = escapeHtml(it.last_error || "");
					const se = escapeHtml(it.purchase_receipt || "");
					const canReprint = Boolean(epcRaw) && statusRaw !== "Consumed";
					const reprintBtn = canReprint
						? `<button type="button" class="btn btn-default btn-xs rfz-reprint"
							data-epc="${epc}"
							data-item-code="${item}"
							data-item-name="${name}"
							data-qty="${qty}"
							data-uom="${uom}"
							data-consume-ant-id="${ant}"
						  >Reprint</button>`
						: `<button type="button" class="btn btn-default btn-xs" disabled title="Consumed">Reprint</button>`;
					$itemRecentBody.append(`
						<tr>
							<td>${i + 1}</td>
							<td><code>${epc}</code></td>
							<td><div><code>${item}</code></div><div class="text-muted">${name}</div></td>
							<td>${qty}</td>
							<td>${uom}</td>
							<td>${ant}</td>
							<td>${st}${err ? `<div class="text-muted" style="max-width:260px">${err}</div>` : ""}</td>
							<td>${se ? `<a href="/app/stock-entry/${se}" target="_blank" rel="noopener noreferrer">${se}</a>` : ""}</td>
							<td>${reprintBtn}</td>
						</tr>
					`);
				}
			}

		async function resolveItemDefaults(itemCode) {
			const code = String(itemCode || "").trim();
			if (!code) {
				itemState.itemStockUom = "";
				return;
			}
			try {
				const r = await frappe.call("frappe.client.get_value", {
					doctype: "Item",
					filters: { name: code },
					fieldname: ["item_name", "stock_uom"],
				});
				const v = r?.message;
				const uom = String(v?.stock_uom || "").trim();
				itemState.itemStockUom = uom;
				if (uom && itemState.controls.uom) {
					itemState.controls.uom.set_value(uom);
				}
			} catch {
				itemState.itemStockUom = "";
				// ignore
			}
		}

		function ensureBatchControls() {
			if (batchControl.product || !$batchProductWrap.length) return;
			batchControl.product = frappe.ui.form.make_control({
				df: {
					label: "Product",
					description: "",
					fieldtype: "Link",
					options: "Item",
					placeholder: "Mahsulot tanlang",
				},
				parent: $batchProductWrap,
				render_input: true,
			});
			batchControl.product.make_input();
			batchControl.product.toggle_label(false);
			const saved = getBatchProduct();
			if (saved) batchControl.product.set_value(saved);
			batchControl.product.$input?.on("change", () => {
				setBatchProduct(batchControl.product.get_value());
			});
		}

		async function ensureItemControls() {
			if (itemState.controlsReady) return;
			if (!$itemGroupWrap.length || !$itemWrap.length) return;

			const me = itemState;

				me.controls.item_group = frappe.ui.form.make_control({
					df: {
						label: "Item Group",
						description: "",
						fieldtype: "Link",
						options: "Item Group",
						placeholder: "Kategoriya",
						onchange: function () {
						try {
							me.controls.item.set_value("");
							itemState.itemStockUom = "";
						} catch {
							// ignore
						}
					},
				},
				parent: $itemGroupWrap,
				render_input: true,
			});

				me.controls.item = frappe.ui.form.make_control({
					df: {
						label: "Item",
						description: "",
						fieldtype: "Link",
						options: "Item",
						placeholder: "Mahsulot",
						onchange: function () {
						itemState.itemStockUom = "";
						resolveItemDefaults(this.value).catch(() => {});
					},
					get_query: function () {
						const g = String(me.controls.item_group.get_value() || "").trim();
						return g ? { filters: { item_group: g } } : {};
					},
				},
				parent: $itemWrap,
				render_input: true,
			});

				me.controls.qty = frappe.ui.form.make_control({
					df: { label: "Qty", description: "", fieldtype: "Float", placeholder: "1" },
					parent: $qtyWrap,
					render_input: true,
				});
				me.controls.uom = frappe.ui.form.make_control({
					df: { label: "UOM", description: "", fieldtype: "Link", options: "UOM", placeholder: "kg" },
					parent: $uomWrap,
					render_input: true,
				});
					me.controls.ant = frappe.ui.form.make_control({
						df: {
							label: "ANT",
							description:
								"0 = istalgan antenna. 1..31 = faqat shu antenna (qat'iy qilish: rfidenter_zebra_consume_requires_ant_match=1).",
							fieldtype: "Select",
							options: ["0", ...Array.from({ length: 31 }, (_, i) => String(i + 1))].join("\n"),
							default: "0",
						},
					parent: $antWrap,
					render_input: true,
				});

			me.controls.item_group.toggle_label(false);
			me.controls.item.toggle_label(false);
			me.controls.qty.toggle_label(false);
				me.controls.uom.toggle_label(false);
				me.controls.ant.toggle_label(false);

				me.controls.qty.set_value(1);
				me.controls.ant.set_value("0");

				itemState.controlsReady = true;
			}

			async function processItemQueue() {
			if (itemState.processing) return;
			itemState.processing = true;
			try {
				const queue = loadItemQueue();
				let changed = false;

				for (const job of queue) {
					if (!job || job.state === "done") continue;

					if (job.state === "create") {
						setItemStatus("ERPga yuborilmoqda...", { indicator: "gray" });
						try {
							const r = await frappe.call("rfidenter.rfidenter.api.zebra_create_item_tag", {
								item_code: job.item_code,
								qty: job.qty,
								uom: job.uom,
								consume_ant_id: job.consume_ant_id,
								client_request_id: job.client_request_id,
							});
							const msg = r?.message;
							if (!msg || msg.ok !== true) throw new Error("Tag yaratilmadi");
							job.epc = msg.epc;
							job.tag = msg.tag;
							job.state = "print";
							job.last_error = "";
							changed = true;
						} catch (e) {
							job.tries = Number(job.tries || 0) + 1;
							job.last_error = String(e?.message || e).slice(0, 300);
							changed = true;
							setItemStatus(`Xato: ${job.last_error}`, { indicator: "orange" });
							break;
						}
					}

						if (job.state === "print") {
							const epc = String(job.epc || "").trim();
							if (!epc) {
								job.state = "create";
								changed = true;
								continue;
							}

								setItemStatus("Printer resume...", { indicator: "gray" });
								try {
									const tag = job.tag || {};
									await zebraSendZpl("~PS", { timeoutMs: 30000 });

								setItemStatus("Zebra’ga yuborilmoqda...", { indicator: "gray" });
								const zpl = buildItemZpl({
									epc,
									itemCode: tag.item_code || job.item_code,
									itemName: tag.item_name || "",
									qty: tag.qty || job.qty,
									uom: tag.uom || job.uom,
									verifyEpc: false,
								});

								await zebraSendZpl(zpl, { timeoutMs: 90000 });
									const okText = "Print OK";
									const okIndicator = "green";

								try {
									await frappe.call("rfidenter.rfidenter.api.zebra_mark_tag_printed", { epc });
								} catch {
									// ignore
								}

								job.state = "done";
								job.last_error = "";
								changed = true;
								setItemStatus(okText, { indicator: okIndicator });
								await refreshRecentTags({ quiet: true });
								} catch (e) {
									job.tries = Number(job.tries || 0) + 1;
									job.last_error = String(e?.message || e).slice(0, 300);
									changed = true;
									job.state = "error";
									setItemStatus(`Print xato (to‘xtatildi): ${job.last_error}`, { indicator: "red" });
									break;
							}
						}
					}

				if (changed) saveItemQueue(queue);
				renderItemQueue();
		} finally {
			itemState.processing = false;
		}
	}

		function setStatusPill(text, { indicator = "orange", title = "" } = {}) {
			const allowed = ["green", "red", "orange", "gray"];
			$status.removeClass(allowed.join(" "));
			$status.addClass(allowed.includes(indicator) ? indicator : "orange");
			$status.text(String(text || ""));
			if (title) $status.attr("title", String(title));
			else $status.removeAttr("title");
		}

		function setConnected(ok, msg) {
			const connected = Boolean(ok);
			setStatusPill(connected ? "Ulangan" : "Ulanmagan", {
				indicator: connected ? "green" : "red",
				title: msg || "",
			});
			state.status = { ok: connected, message: String(msg || "") };
		}

		function setPill($el, text, { indicator = "gray", title = "" } = {}) {
			if (!$el || !$el.length) return;
			const allowed = ["green", "red", "orange", "gray", "blue"];
			$el.removeClass(allowed.join(" "));
			$el.addClass(allowed.includes(indicator) ? indicator : "gray");
			$el.text(String(text || ""));
			if (title) $el.attr("title", String(title));
			else $el.removeAttr("title");
		}

	function setBatchControlsEnabled(enabled) {
		const disabled = !enabled || state.batch.authBlocked;
		$batchStart.prop("disabled", disabled);
		$batchStop.prop("disabled", disabled);
		$batchSwitch.prop("disabled", disabled);
		$batchDevice.prop("disabled", disabled);
		$batchId.prop("disabled", disabled);
		batchControl.product?.$input?.prop("disabled", disabled);
	}

		function syncDeviceIdFromAgent() {
			if (!$batchDevice.length) return;
			const current = getDeviceId();
			if (current) return;
			const agent = currentAgent();
			const next = String(agent?.device || agent?.agent_id || "").trim();
			if (next) setDeviceId(next);
		}

		function normalizeQueueDepth(raw) {
			if (raw === null || raw === undefined || raw === "") return null;
			const n = Number(raw);
			return Number.isFinite(n) ? n : null;
		}

	function setBatchQueue($el, raw) {
		const n = normalizeQueueDepth(raw);
		$el.text(Number.isFinite(n) ? String(n) : "N/A");
	}

	function setAuthBanner(show, message) {
		if (!$authBanner.length) return;
		if (show) {
			$authBanner.text(message || "Auth required");
			$authBanner.show();
		} else {
			$authBanner.hide();
		}
	}

	function stopBatchPolling() {
		if (state.batch.pollTimer) {
			window.clearInterval(state.batch.pollTimer);
			state.batch.pollTimer = null;
		}
		if (state.batch.pollTimeout) {
			window.clearTimeout(state.batch.pollTimeout);
			state.batch.pollTimeout = null;
		}
		state.batch.pollMode = "";
	}

	function startBatchPolling() {
		if (state.batch.authBlocked) return;
		stopBatchPolling();
		state.batch.pollMode = "interval";
		state.batch.pollTimer = window.setInterval(() => pollDeviceStatus({ quiet: true }), BATCH_POLL_INTERVAL_MS);
	}

	function resetBatchBackoff() {
		state.batch.backoffCount = 0;
		if (state.batch.pollMode === "backoff") startBatchPolling();
	}

	function scheduleBatchBackoff() {
		if (state.batch.authBlocked) return;
		const next = Math.min(state.batch.backoffCount + 1, 6);
		state.batch.backoffCount = next;
		const delay = Math.min(BATCH_BACKOFF_MAX_MS, BATCH_BACKOFF_BASE_MS * Math.pow(2, next - 1));
		if (state.batch.pollTimer) {
			window.clearInterval(state.batch.pollTimer);
			state.batch.pollTimer = null;
		}
		if (state.batch.pollTimeout) window.clearTimeout(state.batch.pollTimeout);
		state.batch.pollMode = "backoff";
		state.batch.pollTimeout = window.setTimeout(() => {
			pollDeviceStatus({ quiet: true }).catch(() => {});
		}, delay);
	}

		function parseCallError(err) {
			const response = err?.responseJSON || {};
			const msg = response?.message || {};
			const status = err?.status || response?.status || err?.xhr?.status || 0;
			const code = msg?.code || "";
			const errorText = msg?.error || msg?.message || err?.message || response?.exc || "";
			const excType = response?.exc_type || "";
			const serverMessages = response?._server_messages || "";
			return { status, code, errorText, excType, serverMessages };
		}

	function isAuthError(info) {
		if (!info) return false;
		if (info.status === 401 || info.status === 403) return true;
		if (info.excType === "PermissionError") return true;
		const msg = `${info.errorText || ""} ${info.serverMessages || ""}`.toLowerCase();
		return msg.includes("token") || msg.includes("rfider");
	}

	function setAuthBlocked(blocked, message) {
		state.batch.authBlocked = blocked;
		setBatchControlsEnabled(!blocked);
		setAuthBanner(blocked, message || "Auth required");
		if (blocked) stopBatchPolling();
	}

	function showBatchConflict(info) {
		const raw = String(info?.code || "").trim();
		let code = raw;
		if (!code) {
			const msg = String(info?.errorText || "").toLowerCase();
				if (msg.includes("batch mismatch")) code = "BATCH_MISMATCH";
				else if (msg.includes("product mismatch")) code = "PRODUCT_MISMATCH";
				else if (msg.includes("seq")) code = "SEQ_REGRESSION";
			}
			const label = code ? `Conflict: ${code}` : "Conflict";
			setPill($batchStatus, label, { indicator: "orange", title: info?.errorText || "" });
			frappe.msgprint({
				title: "Conflict",
				message: escapeHtml(info?.errorText || code || "Conflict"),
				indicator: "orange",
			});
		}

	function showBatchError(err) {
		const info = parseCallError(err);
		if (isAuthError(info)) {
			setAuthBlocked(true, "Auth required");
			setPill($batchStatus, "Auth error", { indicator: "red", title: info?.errorText || "" });
			frappe.msgprint({
				title: "Auth error",
				message: escapeHtml(info?.errorText || "Token/role xato."),
				indicator: "red",
			});
			return;
		}
		if (info.status === 429 || info.status === 503) {
			scheduleBatchBackoff();
			setPill($batchStatus, "Backoff", { indicator: "orange", title: info?.errorText || "" });
			return;
		}
		if (info.status === 409) {
			showBatchConflict(info);
			return;
		}
		setPill($batchStatus, "Xato", { indicator: "orange", title: info?.errorText || "" });
			if (info?.errorText) {
				frappe.msgprint({ title: "Batch xatosi", message: escapeHtml(info.errorText), indicator: "red" });
			}
		}

		function renderBatchState(data, meta) {
			const status = String(data?.status || "Stopped").trim() || "Stopped";
			const pauseReason = String(data?.pause_reason || "").trim();
			const lastSeen = data?.last_seen_at || "";
			const lastSeq = data?.last_event_seq;
			const currentBatch = String(data?.current_batch_id || "").trim();
			const currentProduct = String(data?.current_product || "").trim();
			const pendingProduct = String(data?.pending_product || "").trim();

			const pauseKey = pauseReason.replace(/[^a-zA-Z_]/g, "").toUpperCase();
			const isPrinterPause = status === "Paused" && pauseKey.startsWith("PRINTER");
			const isScanRequired =
				status === "ScanReconRequired" ||
				pauseKey.includes("SCANRECON") ||
				pauseKey.includes("SCAN_RECON") ||
				pauseKey.includes("SCANREQUIRED");
			const resumeNote = isPrinterPause || isScanRequired ? "Resume requires operator" : "";
			const statusLabel = isScanRequired
				? `Scan required${resumeNote ? ` · ${resumeNote}` : ""}`
				: pauseReason && status === "Paused"
					? `${status} · ${pauseReason}${resumeNote ? ` · ${resumeNote}` : ""}`
					: status;
			const statusIndicator = status === "Running" ? "green" : status === "Paused" || isScanRequired ? "orange" : "gray";
			setPill($batchState, statusLabel, { indicator: statusIndicator });

			const lastSeenTs = parseServerTime(lastSeen);
			const online = lastSeenTs && Date.now() - lastSeenTs <= 10000;
			setPill($batchDeviceStatus, online ? "Online" : "Offline", { indicator: online ? "green" : "red" });
			$batchLastSeen.text(fmtServerTime(lastSeen));
			$batchLastSeq.text(Number.isFinite(Number(lastSeq)) ? String(lastSeq) : "--");
			$batchCurrentBatch.text(currentBatch || "--");
			$batchCurrentProduct.text(currentProduct || "--");
			$batchPendingProduct.text(pendingProduct || "--");

			if (currentBatch && !getBatchId()) setBatchId(currentBatch);
			if (currentProduct && !getBatchProduct()) setBatchProduct(currentProduct);

			state.batch.lastEventSeq = Number.isFinite(Number(lastSeq)) ? Number(lastSeq) : state.batch.lastEventSeq;

			const printDepth = meta?.print_outbox_depth ?? data?.print_outbox_depth;
			const erpDepth = meta?.erp_outbox_depth ?? data?.erp_outbox_depth;
			const agentDepth = meta?.agent_queue_depth ?? data?.agent_queue_depth;
			setBatchQueue($batchQueuePrint, printDepth);
			setBatchQueue($batchQueueErp, erpDepth);
			setBatchQueue($batchQueueAgent, agentDepth);
		}

	async function fetchBatchState(deviceId) {
		try {
			const r = await frappe.call("frappe.client.get_value", {
				doctype: "RFID Batch State",
					filters: { device_id: deviceId },
					fieldname: [
						"status",
						"pause_reason",
						"current_batch_id",
						"current_product",
						"pending_product",
						"last_event_seq",
						"last_seen_at",
					],
					as_dict: 1,
				});
				return r?.message || null;
		} catch {
			return null;
		}
	}

	async function fetchDeviceStatus(deviceId, batchId) {
		const payload = { event_id: newEventId(), device_id: deviceId };
		if (batchId) payload.batch_id = batchId;
		const r = await frappe.call("rfidenter.device_status", payload);
		const msg = r?.message;
		if (!msg || msg.ok !== true) throw new Error("Status olinmadi");
		return msg;
	}

	async function pollDeviceStatus({ quiet = false } = {}) {
		if (state.batch.authBlocked) return;
		const deviceId = getDeviceId();
			if (!deviceId) {
				setBatchControlsEnabled(false);
				if (!quiet) setPill($batchStatus, "Device ID kerak", { indicator: "orange" });
				return;
			}
			setBatchControlsEnabled(true);
			setAuthBanner(false);
			try {
				const batchId = getBatchId();
				const msg = await fetchDeviceStatus(deviceId, batchId);
				resetBatchBackoff();
				const stateData = msg.state || (await fetchBatchState(deviceId));
				if (stateData) {
					renderBatchState(stateData, msg);
					setPill($batchStatus, "");
				} else if (!quiet) {
				setPill($batchStatus, "State topilmadi", { indicator: "orange" });
			}
		} catch (err) {
			showBatchError(err);
		}
		}

		async function callBatchEndpoint(method, payload) {
			try {
				const r = await frappe.call(method, payload);
				const msg = r?.message;
				if (!msg || msg.ok !== true) throw new Error(msg?.error || "Xato");
				return msg;
			} catch (err) {
				showBatchError(err);
				return null;
			}
		}

	async function startBatch() {
		const deviceId = getDeviceId();
		const batchId = getBatchId();
		const productId = getBatchProduct();
		if (!deviceId) return setPill($batchStatus, "Device ID kerak", { indicator: "orange" });
		if (!batchId) return setPill($batchStatus, "Batch ID kerak", { indicator: "orange" });
		if (!productId) return setPill($batchStatus, "Product tanlang", { indicator: "orange" });
		setPill($batchStatus, "Start...", { indicator: "gray" });
		const payload = {
			event_id: newEventId(),
			device_id: deviceId,
			batch_id: batchId,
			product_id: productId,
		};
		const msg = await callBatchEndpoint("rfidenter.edge_batch_start", payload);
		if (msg) pollDeviceStatus({ quiet: true });
	}

	async function stopBatch() {
		const deviceId = getDeviceId();
		const batchId = getBatchId();
		if (!deviceId) return setPill($batchStatus, "Device ID kerak", { indicator: "orange" });
		if (!batchId) return setPill($batchStatus, "Batch ID kerak", { indicator: "orange" });
		setPill($batchStatus, "Stop...", { indicator: "gray" });
		const payload = {
			event_id: newEventId(),
			device_id: deviceId,
			batch_id: batchId,
		};
		const msg = await callBatchEndpoint("rfidenter.edge_batch_stop", payload);
		if (msg) pollDeviceStatus({ quiet: true });
	}

	async function switchBatchProduct() {
		const deviceId = getDeviceId();
		const batchId = getBatchId();
		const productId = getBatchProduct();
		if (!deviceId) return setPill($batchStatus, "Device ID kerak", { indicator: "orange" });
		if (!batchId) return setPill($batchStatus, "Batch ID kerak", { indicator: "orange" });
		if (!productId) return setPill($batchStatus, "Product tanlang", { indicator: "orange" });
		setPill($batchStatus, "Switch...", { indicator: "gray" });
		const payload = {
			event_id: newEventId(),
			device_id: deviceId,
			batch_id: batchId,
			product_id: productId,
		};
		const msg = await callBatchEndpoint("rfidenter.edge_product_switch", payload);
			if (msg) pollDeviceStatus({ quiet: true });
		}

		function updateConnectionUi() {
			const mode = getConnMode();
			$connMode.val(mode);
		$connAgentWrap.toggle(mode === "agent");
		$connLocalWrap.toggle(mode === "local");
	}

	function currentAgent() {
		const want = getSelectedAgentId();
		const agents = Array.isArray(state.agents) ? state.agents : [];
		return agents.find((a) => String(a?.agent_id || "").trim() === want) || null;
	}

	function renderAgentOptions() {
		const agents = Array.isArray(state.agents) ? state.agents : [];
		const selected = getSelectedAgentId();
		$connAgent.empty();

		if (!agents.length) {
			$connAgent.append(`<option value="">(Zebra agent topilmadi)</option>`);
			$connAgent.val("");
			$connAgentHint.text("Zebra servisida ERP agent yoqing (env: ZEBRA_ERP_URL + ZEBRA_ERP_AUTH).");
			return;
		}

		for (const a of agents) {
			const agentId = String(a?.agent_id || "").trim();
			const device = String(a?.device || agentId || "Zebra").trim();
			const lastSeen = fmtTime(a?.last_seen);
			const label = lastSeen ? `${device} · ${lastSeen}` : device;
			$connAgent.append(`<option value="${escapeHtml(agentId)}">${escapeHtml(label)}</option>`);
		}

		const next = agents.some((a) => String(a?.agent_id || "").trim() === selected) ? selected : String(agents[0]?.agent_id || "");
		$connAgent.val(next);
		setSelectedAgentId(next);
		syncDeviceIdFromAgent();
		$connAgentHint.text("");
	}

	function updateMode() {
		const selected = String($body.find('input[name="rfidenter-zebra-mode"]:checked').val() || "manual");
		state.mode = selected;
		$modeManual.toggle(selected === "manual");
		$modeAuto.toggle(selected === "auto");
	}

	function updateCopies() {
		const enabled = Boolean($copiesEnabled.prop("checked"));
		$copies.prop("readonly", !enabled);
		if (!enabled) $copies.val("2");
	}

	function updateFeedBehavior() {
		const printingEnabled = Boolean($printText.prop("checked"));
		$feedAfter.prop("disabled", printingEnabled);
		if (printingEnabled) $feedAfter.prop("checked", false);
	}

	function renderConfig() {
		const c = state.config || {};
		$cfg.text(
			JSON.stringify(
				{
					vendor_id: c?.zebra_vendor_id,
					product_id: c?.zebra_product_id,
					device_path: c?.zebra_device_path,
					feed_after_encode: c?.zebra_feed_after_encode,
					template_enabled: c?.zebra_template_enabled,
					transport: c?.transport || c?.zebra_transport,
					transceive_supported: c?.transceive_supported ?? c?.zebra_transceive_supported,
				},
				null,
				0
			)
		);
	}

	function isTransceiveSupported() {
		const c = state.config || {};
		if (c?.transceive_supported === true || c?.transceive_supported === false) return Boolean(c.transceive_supported);
		if (c?.zebra_transceive_supported === true || c?.zebra_transceive_supported === false)
			return Boolean(c.zebra_transceive_supported);
		const transport = String(c?.transport || c?.zebra_transport || "").trim().toLowerCase();
		return transport ? transport === "usb" : true;
	}

	function applyTransportCapabilities() {
		if (!$itemReadEpc.length) return;
		const supported = isTransceiveSupported();
		$itemReadEpc.prop("disabled", !supported);
		$itemReadEpc.attr(
			"title",
			supported
				? "Tag ichidagi EPC’ni o‘qish"
				: "EPC o‘qish uchun USB transport kerak (ZEBRA_TRANSPORT=usb)"
		);
	}

	function renderDevices() {
		$devices.empty();
		const list = Array.isArray(state.devices) ? state.devices : [];
		if (!list.length) {
			$devices.append(`<tr><td colspan="2" class="text-muted">Device topilmadi</td></tr>`);
			return;
		}
		for (const d of list) {
			const vendorId = Number(d?.vendor_id);
			const productId = Number(d?.product_id);
			const id =
				Number.isFinite(vendorId) && Number.isFinite(productId)
					? `0x${vendorId.toString(16).toUpperCase().padStart(4, "0")}:0x${productId
							.toString(16)
							.toUpperCase()
							.padStart(4, "0")}`
					: "0x????:0x????";
			const info = [
				d?.manufacturer ? String(d.manufacturer) : "",
				d?.product ? String(d.product) : "",
				d?.bus != null && d?.address != null ? `bus ${d.bus} addr ${d.address}` : "",
			]
				.filter(Boolean)
				.join(" · ");
			$devices.append(`
				<tr>
					<td><code>${escapeHtml(id)}</code></td>
					<td class="text-muted">${escapeHtml(info || "(info yo‘q)")}</td>
				</tr>
			`);
		}
	}

	function renderResult() {
		const r = state.result;
		if (!r) {
			$resultWrap.hide();
			return;
		}
		const ok = Boolean(r.ok);
		const requested = Number(r.total_labels_requested || 0);
		const succeeded = Number(r.total_labels_succeeded || 0);
		const uniqueOk = Number(r.unique_epcs_succeeded || 0);
		$resultWrap.show();
		$resultAlert
			.removeClass("alert-success alert-danger alert-warning")
			.addClass(ok ? "alert-success" : succeeded ? "alert-warning" : "alert-danger")
			.html(
				ok
					? `OK · Requested: <b>${escapeHtml(requested)}</b> · Succeeded: <b>${escapeHtml(succeeded)}</b>`
					: `Partial · Requested: <b>${escapeHtml(requested)}</b> · Succeeded: <b>${escapeHtml(succeeded)}</b> · Unique OK: <b>${escapeHtml(
							uniqueOk
					  )}</b>`
			);

		$resultBody.empty();
		const items = Array.isArray(r.items) ? r.items : [];
		const okEpcs = [];
		for (let i = 0; i < items.length; i++) {
			const it = items[i];
			const itOk = Boolean(it?.ok);
			const epcHex = String(it?.epc_hex || "");
			const copies = Number(it?.copies || 1);
			const msg = String(it?.message || "");
			if (itOk && epcHex) okEpcs.push(epcHex);
			$resultBody.append(`
				<tr class="${itOk ? "success" : "danger"}">
					<td>${i + 1}</td>
					<td><code>${escapeHtml(epcHex)}</code></td>
					<td>${escapeHtml(copies)}</td>
					<td>${itOk ? '<span class="text-success">OK</span>' : '<span class="text-danger">Error</span>'}</td>
					<td class="text-muted">${escapeHtml(msg)}</td>
				</tr>
			`);
		}
		$epcList.val(okEpcs.join("\n"));
	}

	async function refreshAll({ quiet = false } = {}) {
		updateConnectionUi();
		setStatusPill("Tekshirilmoqda...", { indicator: "orange" });

		const connMode = getConnMode();
		if (connMode === "local") {
			state.baseUrl = getBaseUrl();
			$url.val(state.baseUrl);
			$open.attr("href", `${state.baseUrl}/`);

			try {
				setStatusPill("Tekshirilmoqda...", { indicator: "orange" });
				const health = await zebraFetch("/api/v1/health", { timeoutMs: 2500 });
				if (health?.ok !== true) throw new Error("Health not ok");
				setConnected(true);
			} catch (e) {
				// Common case: port changed (auto-selected). If a loopback Zebra agent is online,
				// sync local URL from it and retry once.
				let err = e;
				try {
					const changed = await trySyncLocalUrlFromAgent({ quiet: true });
					if (changed) {
						state.baseUrl = getBaseUrl();
						try {
							setStatusPill("Tekshirilmoqda...", { indicator: "orange" });
							const health2 = await zebraFetch("/api/v1/health", { timeoutMs: 2500 });
							if (health2?.ok !== true) throw new Error("Health not ok");
							setConnected(true);
							err = null;
						} catch (e2) {
							err = e2;
						}
					}
				} catch {
					// ignore
				}

				if (err) {
					setConnected(false, err?.message || err);
					if (!quiet) {
						frappe.msgprint({
							title: "Zebra ulanish xatosi",
							message: escapeHtml(err?.message || err),
							indicator: "red",
						});
					}
					return;
				}
			}

			try {
				state.config = await zebraFetch("/api/v1/config");
			} catch {
				state.config = null;
			}
			try {
				state.devices = await zebraFetch("/api/v1/usb-devices");
			} catch {
				state.devices = [];
			}

			renderConfig();
			applyTransportCapabilities();
			renderDevices();
			return;
		}

		// Agent mode: ERP orqali (brauzer local zebra URL'ga ulanmaydi)
		try {
			setStatusPill("Agentlar yuklanmoqda...", { indicator: "orange" });
			await refreshAgents();
			renderAgentOptions();
		} catch (e) {
			state.agents = [];
			renderAgentOptions();
			setConnected(false, e?.message || e);
			if (!quiet) {
				frappe.msgprint({
					title: "Agent xatosi",
					message: escapeHtml(e?.message || e),
					indicator: "red",
				});
			}
			return;
		}

		const agent = currentAgent();
		if (!agent) {
			const switched = await maybeAutoSwitchToLocal({ quiet });
			if (switched) return;
			setConnected(false, "Zebra agent offline");
			state.config = null;
			state.devices = [];
			$open.attr("href", `${getBaseUrl()}/`);
			renderConfig();
			renderDevices();
			return;
		}

		const urls = Array.isArray(agent?.ui_urls) ? agent.ui_urls : [];
		const bestUrl = String(urls[0] || "").trim();
		$open.attr("href", `${normalizeBaseUrl(bestUrl || getBaseUrl())}/`);

		try {
			const healthReply = await agentCall("ZEBRA_HEALTH", {}, { timeoutMs: 4000 });
			if (!healthReply?.ok) throw new Error(healthReply?.error || "Health failed");
			setConnected(true);
		} catch (e) {
			setConnected(false, e?.message || e);
			if (!quiet) {
				frappe.msgprint({ title: "Zebra agent xatosi", message: escapeHtml(e?.message || e), indicator: "red" });
			}
			return;
		}

		try {
			const reply = await agentCall("ZEBRA_RUNTIME_CONFIG", {}, { timeoutMs: 15000 });
			if (!reply?.ok) throw new Error(reply?.error || "Config error");
			state.config = reply.result;
		} catch {
			state.config = null;
		}
		try {
			const reply = await agentCall("ZEBRA_USB_DEVICES", {}, { timeoutMs: 15000 });
			if (!reply?.ok) throw new Error(reply?.error || "USB error");
			state.devices = Array.isArray(reply.result) ? reply.result : [];
		} catch {
			state.devices = [];
		}

		renderConfig();
		applyTransportCapabilities();
		renderDevices();
	}

	async function feedLabel() {
		try {
			$writeStatus.text("Feeding...");

			await zebraSendZpl("~PH", { timeoutMs: 30000 });
			$writeStatus.text("OK");
		} catch (e) {
			$writeStatus.text("");
			frappe.msgprint({ title: "Feed xatosi", message: escapeHtml(e?.message || e), indicator: "red" });
		}
	}

	async function doEncode() {
		try {
			$write.prop("disabled", true);
			$writeStatus.text("Yuborilmoqda...");
			$copyStatus.text("");

			const mode = state.mode;
			const printHuman = Boolean($printText.prop("checked"));
			const feedAfter = Boolean($feedAfter.prop("checked"));

			let payload;
			if (mode === "auto") {
				const count = clampInt($autoCount.val(), { min: 1, max: 1000, fallback: 1 });
				payload = {
					mode: "auto",
					auto_count: count,
					print_human_readable: printHuman,
					feed_after_encode: feedAfter,
				};
			} else {
				const epc = String($epc.val() || "").trim();
				if (!epc) throw new Error("EPC kiritilmagan.");
				const copiesEnabled = Boolean($copiesEnabled.prop("checked"));
				const copies = copiesEnabled ? clampInt($copies.val(), { min: 1, max: 1000, fallback: 1 }) : 1;
				payload = {
					mode: "manual",
					items: [{ epc, copies }],
					print_human_readable: printHuman,
					feed_after_encode: feedAfter,
				};
				}

				let r;
				let connMode = getConnMode();
				if (connMode === "agent" && !getSelectedAgentId()) {
					await switchToLocalIfPossible({ quiet: false, message: "Zebra agent topilmadi — Local URL orqali davom etyapmiz." });
					connMode = getConnMode();
				}

				if (connMode === "agent") {
					const reply = await agentCall("ZEBRA_ENCODE_BATCH", payload, { timeoutMs: 120000 });
					if (!reply?.ok) throw new Error(reply?.error || "Encode failed");
					r = reply.result;
				} else {
					r = await zebraFetch("/api/v1/encode-batch", { method: "POST", body: payload, timeoutMs: 60000 });
			}
			state.result = r || null;
			renderResult();
			$writeStatus.text(r?.ok ? "OK" : "Partial");
		} catch (e) {
			$writeStatus.text("");
			frappe.msgprint({ title: "Print xatosi", message: escapeHtml(e?.message || e), indicator: "red" });
		} finally {
			$write.prop("disabled", false);
		}
	}

	async function copyEpcList() {
		try {
			const text = String($epcList.val() || "").trim();
			if (!text) {
				$copyStatus.text("EPC yo‘q");
				return;
			}
			if (navigator.clipboard && window.isSecureContext) {
				await navigator.clipboard.writeText(text);
			} else {
				$epcList[0].focus();
				$epcList[0].select();
				document.execCommand("copy");
				$epcList[0].setSelectionRange(0, 0);
			}
			$copyStatus.text("Copied");
		} catch {
			$copyStatus.text("Copy failed");
		}
	}

	$body.find('input[name="rfidenter-zebra-mode"]').on("change", () => updateMode());
	$copiesEnabled.on("change", () => updateCopies());
	$printText.on("change", () => updateFeedBehavior());

	// Realtime: resolve pending requests instantly (agent mode).
	frappe.realtime.on("rfidenter_agent_reply", (reply) => {
		try {
			const requestId = String(reply?.request_id || "").trim();
			const pending = state.pending.get(requestId);
			if (!pending) return;
			state.pending.delete(requestId);
			window.clearTimeout(pending.timer);
			pending.resolve(reply);
		} catch {
			// ignore
		}
	});
	frappe.realtime.on("rfidenter_scale_weight", (payload) => {
		try {
			handleScalePayload(payload);
		} catch {
			// ignore
		}
	});

	$batchDevice.on("change", () => {
		setDeviceId($batchDevice.val());
		pollDeviceStatus({ quiet: true });
	});
	$batchDevice.on("keydown", (e) => {
		if (e.key !== "Enter") return;
		setDeviceId($batchDevice.val());
		pollDeviceStatus({ quiet: true });
	});
	$batchId.on("change", () => {
		setBatchId($batchId.val());
	});
	$batchId.on("keydown", (e) => {
		if (e.key !== "Enter") return;
		setBatchId($batchId.val());
	});
	$batchStart.on("click", () => startBatch());
	$batchStop.on("click", () => stopBatch());
	$batchSwitch.on("click", () => switchBatchProduct());

	$connMode.on("change", () => {
		autoFallbackAllowed = false;
		setConnMode($connMode.val());
		updateConnectionUi();
		refreshAll({ quiet: true });
	});

	$connAgent.on("change", () => {
		setSelectedAgentId($connAgent.val());
		syncDeviceIdFromAgent();
		refreshAll({ quiet: true });
	});

	$body.find(".rfidenter-agent-refresh").on("click", () => {
		refreshAll();
	});

	$body.find(".rfidenter-zebra-refresh").on("click", () => {
		setBaseUrl($url.val());
		refreshAll();
	});
		$url.on("keydown", (e) => {
			if (e.key !== "Enter") return;
			setBaseUrl($url.val());
			refreshAll({ quiet: true });
		});
			$body.find(".rfz-open-settings").on("click", () => {
				frappe.set_route("List", "RFID Zebra Item Receipt Setting");
			});
			$itemReadEpc.on("click", async () => {
				try {
					if (!isTransceiveSupported()) {
						const msg = "Transceive USB transport talab qiladi (ZEBRA_TRANSPORT=usb).";
						setItemStatus(`Read xato: ${msg}`, { indicator: "orange" });
						frappe.msgprint({ title: "Read xatosi", message: escapeHtml(msg), indicator: "red" });
						return;
					}
					$itemReadEpc.prop("disabled", true);
					setItemStatus("EPC o‘qilmoqda...", { indicator: "gray" });
					const tr = await zebraTransceiveZpl(buildReadCurrentEpcZpl(), { readTimeoutMs: 4000, timeoutMs: 30000 });
					const output = String(tr?.output || "");
					const epc = extractEpcFromHv(output, HV_CURRENT_EPC);
					if (epc) {
						setItemStatus(`Tag EPC: ${epc}`, { indicator: "green" });
						frappe.msgprint({ title: "Tag EPC", message: `<code>${escapeHtml(epc)}</code>`, indicator: "green" });
					} else if (hasHvMarker(output, HV_CURRENT_EPC)) {
						setItemStatus("Tag EPC: (bo‘sh)", { indicator: "orange" });
						frappe.msgprint({ title: "Tag EPC", message: escapeHtml("(bo‘sh)"), indicator: "orange" });
					} else {
						setItemStatus("EPC topilmadi.", { indicator: "orange" });
						frappe.msgprint({
							title: "Tag EPC",
							message: escapeHtml(output || "Javob yo‘q."),
							indicator: "orange",
						});
					}
				} catch (e) {
					const msg = String(e?.message || e);
					setItemStatus(`Read xato: ${msg}`, { indicator: "orange" });
					frappe.msgprint({
						title: "Read xatosi",
						message: escapeHtml(
							isTransceiveUnsupportedError(e)
								? `${msg}\n\nEslatma: EPC o‘qish uchun zebra-bridge PyUSB mode kerak (ZEBRA_DEVICE_PATH o‘chirilgan bo‘lsin).`
								: msg
						),
						indicator: "red",
					});
				} finally {
					$itemReadEpc.prop("disabled", false);
				}
			});
			$itemStop.on("click", () => {
				frappe.confirm("Printer navbatini to‘xtatamizmi? (~JA)", () => {
					(async () => {
						try {
							$itemStop.prop("disabled", true);
							setItemStatus("To‘xtatilmoqda...", { indicator: "gray" });

							await zebraSendZpl("~JA", { timeoutMs: 30000 });

							setItemStatus("To‘xtatish yuborildi.", { indicator: "orange" });
						} catch (e) {
							setItemStatus(`Stop xato: ${e?.message || e}`, { indicator: "orange" });
							frappe.msgprint({ title: "Stop xatosi", message: escapeHtml(e?.message || e), indicator: "red" });
						} finally {
							$itemStop.prop("disabled", false);
						}
					})().catch(() => {});
				});
			});
			$itemCalibrate.on("click", () => {
				frappe.confirm("Media kalibratsiya qilinsinmi? (1-3 label ketishi mumkin)", () => {
					(async () => {
						try {
							$itemCalibrate.prop("disabled", true);
							setItemStatus("Kalibratsiya yuborilmoqda...", { indicator: "gray" });
							await zebraSendZpl("~JC", { timeoutMs: 30000 });
							setItemStatus("Kalibratsiya yuborildi.", { indicator: "green" });
						} catch (e) {
							setItemStatus(`Kalibratsiya xato: ${e?.message || e}`, { indicator: "orange" });
							frappe.msgprint({
								title: "Kalibratsiya xatosi",
								message: escapeHtml(e?.message || e),
								indicator: "red",
							});
						} finally {
							$itemCalibrate.prop("disabled", false);
						}
					})().catch(() => {});
				});
			});
			$itemPrint.on("click", async () => {
				await ensureItemControls();
				const itemCode = String(itemState.controls.item?.get_value?.() || "").trim();
				const qty = Number(itemState.controls.qty?.get_value?.() || 0);
			const uom = String(itemState.controls.uom?.get_value?.() || "").trim();
			const ant = String(itemState.controls.ant?.get_value?.() || "0").trim();

			if (!itemCode) {
				setItemStatus("Mahsulot tanlang.", { indicator: "orange" });
				return;
			}
			if (!Number.isFinite(qty) || qty <= 0) {
				setItemStatus("Qty noto‘g‘ri.", { indicator: "orange" });
				return;
			}
			if (!uom) {
				setItemStatus("UOM tanlang.", { indicator: "orange" });
				return;
			}

			const queue = loadItemQueue();
			queue.unshift({
				client_request_id: newClientRequestId(),
				state: "create",
				item_code: itemCode,
				qty,
				uom,
				consume_ant_id: clampInt(ant, { min: 0, max: 31, fallback: 0 }),
				created_at: Date.now(),
				tries: 0,
				last_error: "",
			});
			saveItemQueue(queue);
			renderItemQueue();
			setItemStatus("Navbatga qo‘shildi.", { indicator: "gray" });
			processItemQueue().catch(() => {});
		});
		$body.find(".rfidenter-zebra-feed").on("click", () => feedLabel());
		$body.find(".rfidenter-zebra-write").on("click", () => doEncode());
		$copyBtn.on("click", () => copyEpcList());
		if ($scaleAutofill.length) {
			$scaleAutofill.prop("checked", scaleAutofillEnabled());
			$scaleAutofill.on("change", () => {
				setScaleAutofill($scaleAutofill.is(":checked"));
			});
		}

	updateMode();
	updateCopies();
	updateFeedBehavior();
		setConnMode(getConnMode());
		updateConnectionUi();
		setBaseUrl(getBaseUrl());
		ensureBatchControls();
		setDeviceId(getDeviceId());
		setBatchId(getBatchId());
		setBatchProduct(getBatchProduct());
		ensureItemControls().catch(() => {});
		renderItemQueue();
		refreshRecentTags({ quiet: true }).catch(() => {});
		refreshScaleOnce({ quiet: true }).catch(() => {});
		processItemQueue().catch(() => {});
		try {
			window.addEventListener("online", () => processItemQueue().catch(() => {}));
		} catch {
			// ignore
		}
		try {
			if (itemState.timer) window.clearInterval(itemState.timer);
			itemState.timer = window.setInterval(() => processItemQueue().catch(() => {}), 5000);
		} catch {
			// ignore
		}
		try {
			if (scaleState.timer) window.clearInterval(scaleState.timer);
			scaleState.timer = window.setInterval(() => refreshScaleOnce({ quiet: true }).catch(() => {}), 100);
		} catch {
			// ignore
		}
		refreshAll({ quiet: true });
		try {
			startBatchPolling();
		} catch {
			// ignore
		}
		pollDeviceStatus({ quiet: true });
		try {
			$(wrapper).on("hide", () => stopBatchPolling());
			$(wrapper).on("show", () => {
				startBatchPolling();
				pollDeviceStatus({ quiet: true });
			});
		} catch {
			// ignore
		}
		try {
			window.addEventListener("beforeunload", () => stopBatchPolling());
		} catch {
			// ignore
		}
	};
