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
	const DEFAULT_ZEBRA_URL = "http://127.0.0.1:18000";

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
					.rfidenter-zebra .rfz-topbar {
						display: flex;
						align-items: center;
						justify-content: flex-end;
						margin-bottom: 12px;
					}
					.rfidenter-zebra .rfz-topbar .indicator-pill {
						font-size: 12px;
						padding: 4px 10px;
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
					.rfidenter-zebra .rfz-actions {
						display: flex;
						align-items: flex-end;
						gap: 10px;
						flex-wrap: wrap;
					}
					.rfidenter-zebra .rfz-table {
						margin-top: 12px;
						max-height: 320px;
						overflow: auto;
					}
					.rfidenter-zebra details.rfz-advanced > summary {
						cursor: pointer;
						user-select: none;
						color: #6c7680;
						margin-top: 12px;
					}
					.rfidenter-zebra details.rfz-advanced[open] > summary {
						margin-bottom: 12px;
					}
				</style>

				<div class="rfz-topbar">
					<span class="indicator-pill orange rfidenter-zebra-status">Tekshirilmoqda...</span>
				</div>

				<div class="panel panel-default">
					<div class="panel-heading"><b>Ulanish</b></div>
					<div class="panel-body">
					<div class="flex" style="gap: 10px; align-items: center; flex-wrap: wrap">
						<label class="text-muted" style="margin: 0">Mode</label>
						<select class="form-control input-sm rfidenter-conn-mode" style="width: 220px">
							<option value="agent">Agent (ERP orqali)</option>
							<option value="local">Local URL</option>
						</select>

						<div class="rfidenter-conn-agent flex" style="gap: 10px; align-items: center; flex-wrap: wrap">
							<label class="text-muted" style="margin: 0">Zebra agent</label>
							<select class="form-control input-sm rfidenter-agent" style="width: 360px"></select>
							<button class="btn btn-default btn-sm rfidenter-agent-refresh">Yangilash</button>
							<span class="text-muted rfidenter-agent-hint"></span>
						</div>

						<div class="rfidenter-conn-local flex" style="gap: 10px; align-items: center; flex-wrap: wrap">
							<label class="text-muted" style="margin: 0">Zebra URL</label>
							<input class="form-control input-sm rfidenter-zebra-url" style="width: 360px" placeholder="http://127.0.0.1:18000" />
							<button class="btn btn-default btn-sm rfidenter-zebra-refresh">Yangilash</button>
						</div>

						<a class="btn btn-default btn-sm rfidenter-zebra-open" target="_blank" rel="noopener noreferrer">UI</a>
					</div>
					</div>
				</div>

				<div class="panel panel-default" style="margin-top: 12px">
					<div class="panel-heading">
						<div class="flex" style="align-items:center; justify-content: space-between; gap: 10px; flex-wrap: wrap">
								<b>Mahsulot → RFID Print → Stock Entry</b>
							<button class="btn btn-default btn-xs rfz-open-settings">Item receipt settings</button>
						</div>
					</div>
					<div class="panel-body">
						<div class="row rfz-form-row">
							<div class="col-md-6 rfz-control">
								<label class="text-muted">Kategoriya (Item Group)</label>
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
								<label class="text-muted">Antenna (consume)</label>
								<div class="rfz-ant"></div>
							</div>
							<div class="col-md-3">
								<div class="rfz-actions" style="margin-top: 18px">
									<button class="btn btn-primary btn-sm rfz-print">Print</button>
									<span class="text-muted rfz-status"></span>
									<span class="text-muted rfz-queue"></span>
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
									</tr>
								</thead>
								<tbody class="rfz-recent"></tbody>
							</table>
						</div>
					</div>
				</div>

				<details class="rfz-advanced">
					<summary>Qo‘shimcha</summary>
					<div class="panel panel-default" style="margin-top: 12px">
						<div class="panel-heading"><b>Printer</b></div>
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

					<div class="panel panel-default" style="margin-top: 12px">
						<div class="panel-heading"><b>Encode / Print</b></div>
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

						<button class="btn btn-default btn-sm rfidenter-zebra-feed" style="margin-left: auto">Feed label</button>
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
							<div class="text-muted">EPC’lar Zebra servisida persistent counter bilan generatsiya qilinadi.</div>
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

					<button class="btn btn-primary btn-sm rfidenter-zebra-write">Chop etish / Write</button>
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
		const $itemPrint = $body.find(".rfz-print");
		const $itemStatus = $body.find(".rfz-status");
		const $itemQueue = $body.find(".rfz-queue");
		const $itemRecentBody = $body.find(".rfz-recent");

		const STORAGE_ITEM_QUEUE = "rfidenter.zebra.item_queue.v1";

		const itemState = {
			controlsReady: false,
			processing: false,
			timer: null,
			controls: { item_group: null, item: null, qty: null, uom: null, ant: null },
		};

		function sanitizeZplText(value) {
			const s = String(value ?? "").trim();
			if (!s) return "";
			// Avoid ZPL control characters inside ^FD ... ^FS.
			return s.replaceAll("^", " ").replaceAll("~", " ").replace(/\s+/g, " ").trim().slice(0, 80);
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
			const q = loadItemQueue();
			const pending = q.filter((j) => j && j.state !== "done").length;
			$itemQueue.text(pending ? `Queue: ${pending}` : "");
		}

		function newClientRequestId() {
			const rnd = Math.random().toString(16).slice(2, 10);
			return `rfz-${Date.now()}-${rnd}`;
		}

		function buildItemZpl({ epc, itemCode, itemName, qty, uom }) {
			const line1 = sanitizeZplText(itemCode);
			const line2 = sanitizeZplText(itemName);
			const line3 = sanitizeZplText(`${qty} ${uom}`);
			const line4 = sanitizeZplText(epc);

			// Simple label: encode EPC + print item info.
			// `^RFW,H,,,A` auto-adjusts PC bits for EPC bank writes.
			return [
				"^XA",
				"^RS8,,,1,N",
				`^RFW,H,,,A^FD${epc}^FS`,
				line1 ? `^FO30,30^A0N,34,34^FD${line1}^FS` : "",
				line2 ? `^FO30,70^A0N,28,28^FD${line2}^FS` : "",
				line3 ? `^FO30,110^A0N,34,34^FD${line3}^FS` : "",
				line4 ? `^FO30,155^A0N,22,22^FD${line4}^FS` : "",
				"^PQ1",
				"^XZ",
			]
				.filter(Boolean)
				.join("\n");
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
				$itemRecentBody.append(`<tr><td colspan="8" class="text-muted">(yo‘q)</td></tr>`);
				return;
			}
			for (let i = 0; i < items.length; i++) {
				const it = items[i] || {};
				const epc = escapeHtml(it.epc || "");
				const item = escapeHtml(it.item_code || "");
				const name = escapeHtml(it.item_name || "");
				const qty = escapeHtml(it.qty ?? "");
				const uom = escapeHtml(it.uom || "");
				const ant = escapeHtml(it.consume_ant_id ?? "");
				const st = escapeHtml(it.status || "");
				const err = escapeHtml(it.last_error || "");
				const se = escapeHtml(it.purchase_receipt || "");
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
					</tr>
				`);
			}
		}

		async function resolveItemDefaults(itemCode) {
			const code = String(itemCode || "").trim();
			if (!code) return;
			try {
				const r = await frappe.call("frappe.client.get_value", {
					doctype: "Item",
					filters: { name: code },
					fieldname: ["item_name", "stock_uom"],
				});
				const v = r?.message;
				const uom = String(v?.stock_uom || "").trim();
				if (uom && itemState.controls.uom && !itemState.controls.uom.get_value()) {
					itemState.controls.uom.set_value(uom);
				}
			} catch {
				// ignore
			}
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
						description: "",
						fieldtype: "Select",
						options: ["0", ...Array.from({ length: 31 }, (_, i) => String(i + 1))].join("\n"),
						default: "1",
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
			me.controls.ant.set_value("1");

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

							setItemStatus("Zebra’ga yuborilmoqda...", { indicator: "gray" });
							try {
								const tag = job.tag || {};
								const zpl = buildItemZpl({
									epc,
									itemCode: tag.item_code || job.item_code,
									itemName: tag.item_name || "",
									qty: tag.qty || job.qty,
									uom: tag.uom || job.uom,
								});

								let connMode = getConnMode();
								if (connMode === "agent" && !getSelectedAgentId()) {
									await switchToLocalIfPossible({ quiet: true });
									connMode = getConnMode();
								}

								if (connMode === "agent") {
									const reply = await agentCall("ZEBRA_PRINT_ZPL", { zpl, copies: 1 }, { timeoutMs: 90000 });
									if (!reply?.ok) throw new Error(reply?.error || "Print failed");
								} else {
									await zebraFetch("/v1/print-jobs", { method: "POST", body: { zpl, copies: 1 }, timeoutMs: 60000 });
								}

							try {
								await frappe.call("rfidenter.rfidenter.api.zebra_mark_tag_printed", { epc });
							} catch {
								// ignore
							}

							job.state = "done";
							job.last_error = "";
							changed = true;
							setItemStatus("Print OK", { indicator: "green" });
							await refreshRecentTags({ quiet: true });
						} catch (e) {
							job.tries = Number(job.tries || 0) + 1;
							job.last_error = String(e?.message || e).slice(0, 300);
							changed = true;
							setItemStatus(`Print xato: ${job.last_error}`, { indicator: "red" });
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
				},
				null,
				0
			)
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
		renderDevices();
	}

		async function feedLabel() {
			try {
				$writeStatus.text("Feeding...");

				let connMode = getConnMode();
				if (connMode === "agent" && !getSelectedAgentId()) {
					await switchToLocalIfPossible({ quiet: false, message: "Zebra agent topilmadi — Local URL orqali davom etyapmiz." });
					connMode = getConnMode();
				}

				if (connMode === "agent") {
					const reply = await agentCall("ZEBRA_PRINT_ZPL", { zpl: "~PH", copies: 1 }, { timeoutMs: 30000 });
					if (!reply?.ok) throw new Error(reply?.error || "Feed failed");
				} else {
					await zebraFetch("/v1/print-jobs", { method: "POST", body: { zpl: "~PH", copies: 1 } });
				}
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

	$connMode.on("change", () => {
		autoFallbackAllowed = false;
		setConnMode($connMode.val());
		updateConnectionUi();
		refreshAll({ quiet: true });
	});

	$connAgent.on("change", () => {
		setSelectedAgentId($connAgent.val());
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

	updateMode();
	updateCopies();
	updateFeedBehavior();
		setConnMode(getConnMode());
		updateConnectionUi();
		setBaseUrl(getBaseUrl());
		ensureItemControls().catch(() => {});
		renderItemQueue();
		refreshRecentTags({ quiet: true }).catch(() => {});
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
		refreshAll({ quiet: true });
	};
