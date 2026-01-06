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

function setText($el, text) {
	$el.text(String(text ?? ""));
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

frappe.pages["rfidenter-settings"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "RFIDenter Settings",
		single_column: true,
	});

	const STORAGE_AUTH = "rfidenter.erp_push_auth";
	const STORAGE_ZEBRA_URL = "rfidenter.zebra_url";
	const DEFAULT_ZEBRA_URL = "http://127.0.0.1:18000";

	const origin = normalizeBaseUrl(window.location.origin);
	const ingestEndpoint = `${origin}/api/method/rfidenter.rfidenter.api.ingest_tags`;

	const $body = $(`
		<div class="rfidenter-settings">
			<div class="panel panel-default">
				<div class="panel-heading"><b>Server / Token</b></div>
				<div class="panel-body">
					<div style="margin-bottom: 8px"><span class="text-muted">ERP URL:</span> <code class="rfidenter-url"></code></div>
					<div style="margin-bottom: 8px"><span class="text-muted">Ingest endpoint:</span> <code class="rfidenter-endpoint"></code></div>
					<div class="text-muted">
						Token olish va Node konfiguratsiya uchun: <a href="/app/rfidenter-auth">Authentication</a>.
					</div>
				</div>
			</div>

			<div class="panel panel-default" style="margin-top: 12px">
				<div class="panel-heading"><b>Online qurilmalar</b></div>
				<div class="panel-body">
					<div class="text-muted" style="margin-bottom: 10px">
						<b>UHF</b>: Node agent ERP’ga “heartbeat” yuboradi (<code>register_agent</code>).
						<b>Zebra</b>: <code>zebra-epc-web</code> servis (USB printer) — agent mode bilan ERP’ga mustaqil ulanadi.
					</div>

					<div class="flex" style="gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px">
						<label class="text-muted" style="margin: 0">Zebra URL</label>
						<input class="form-control input-sm rfidenter-zebra-url" style="width: 360px" placeholder="http://127.0.0.1:18000" />
						<button class="btn btn-default btn-sm rfidenter-zebra-test">Test</button>
						<a class="btn btn-default btn-sm rfidenter-zebra-open" target="_blank" rel="noopener noreferrer">UI</a>
						<span class="text-muted rfidenter-zebra-status"></span>
					</div>

					<button class="btn btn-default btn-sm rfidenter-refresh-agents">Yangilash</button>
					<span class="text-muted rfidenter-agents-status" style="margin-left: 8px"></span>

					<div class="table-responsive" style="margin-top: 10px">
						<table class="table table-bordered table-hover">
							<thead>
								<tr>
									<th style="width: 54px">Type</th>
									<th style="width: 200px">Device</th>
									<th>URL(lar)</th>
									<th style="width: 180px">Status</th>
									<th style="width: 120px">Action</th>
								</tr>
							</thead>
							<tbody class="rfidenter-agents-tbody"></tbody>
						</table>
					</div>
				</div>
			</div>
		</div>
	`);

	page.main.append($body);
	setText($body.find(".rfidenter-url"), origin);
	setText($body.find(".rfidenter-endpoint"), ingestEndpoint);

	const $agentsStatus = $body.find(".rfidenter-agents-status");
	const $agentsBody = $body.find(".rfidenter-agents-tbody");
	const $zebraUrl = $body.find(".rfidenter-zebra-url");
	const $zebraOpen = $body.find(".rfidenter-zebra-open");
	const $zebraStatus = $body.find(".rfidenter-zebra-status");

	const state = {
		agents: [],
		ttlSec: 0,
		zebra: { ok: false, message: "", checkedAt: 0 },
	};

	function getStoredAuth() {
		return String(window.localStorage.getItem(STORAGE_AUTH) || "").trim();
	}

	function getZebraBaseUrl() {
		return normalizeBaseUrl(window.localStorage.getItem(STORAGE_ZEBRA_URL) || DEFAULT_ZEBRA_URL) || DEFAULT_ZEBRA_URL;
	}

	function setZebraBaseUrl(url) {
		window.localStorage.setItem(STORAGE_ZEBRA_URL, normalizeBaseUrl(url));
	}

	function iconHtml(type) {
		if (type === "zebra") return '<i class="fa fa-print" title="Zebra"></i>';
		return '<i class="fa fa-rss" title="UHF"></i>';
	}

	function isZebraAgent(agent) {
		const kind = String(agent?.kind || "").trim().toLowerCase();
		if (kind === "zebra") return true;
		const agentId = String(agent?.agent_id || "").trim().toLowerCase();
		const version = String(agent?.version || "").trim().toLowerCase();
		return agentId.startsWith("zebra-") || version.includes("zebra");
	}

	function dotHtml(ok) {
		const c = ok ? "#28a745" : "#d9d9d9";
		return `<span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:${c};margin-right:6px"></span>`;
	}

	async function zebraGet(path) {
		const baseUrl = getZebraBaseUrl();
		const url = `${baseUrl}${path}`;
		const headers = {};
		const auth = getStoredAuth();
		if (auth) headers.Authorization = auth;

		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), 2500);
		try {
			const r = await fetch(url, { method: "GET", headers, signal: controller.signal });
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

	async function refreshZebra({ quiet = false } = {}) {
		const baseUrl = getZebraBaseUrl();
		$zebraStatus.text("Tekshirilmoqda...");
		try {
			const data = await zebraGet("/api/v1/health");
			if (data?.ok !== true) throw new Error("Zebra health not ok");
			state.zebra = { ok: true, message: "Online", checkedAt: Date.now() };
			$zebraStatus.text("Online");
			$zebraOpen.attr("href", `${baseUrl}/`);
		} catch (e) {
			state.zebra = { ok: false, message: String(e?.message || e), checkedAt: Date.now() };
			$zebraStatus.text("Offline");
			$zebraOpen.attr("href", `${baseUrl}/`);
			if (!quiet) {
				frappe.show_alert({ message: `Zebra: ${escapeHtml(e?.message || e)}`, indicator: "orange" });
			}
		}
		renderDevices();
	}

	function renderDevices() {
		$agentsBody.empty();
		const zebraUrl = escapeHtml(getZebraBaseUrl());
		const agents = Array.isArray(state.agents) ? state.agents : [];
		const zebraAgents = agents.filter((a) => isZebraAgent(a));
		const uhfAgents = agents.filter((a) => !isZebraAgent(a));

		if (!zebraAgents.length) {
			const zebraOk = Boolean(state.zebra.ok);
			const zebraStatus = zebraOk
				? "Local UI: ulangan"
				: `Agent: offline${state.zebra.message ? ` · Local: ${state.zebra.message}` : ""}`;
			$agentsBody.append(`
				<tr>
					<td>${iconHtml("zebra")}</td>
					<td><code>Zebra</code></td>
					<td><div><a href="${zebraUrl}/" target="_blank" rel="noopener noreferrer">${zebraUrl}</a></div></td>
					<td>${dotHtml(false)}${escapeHtml(zebraStatus)}</td>
					<td>
						<a class="btn btn-primary btn-xs" href="${zebraUrl}/" target="_blank" rel="noopener noreferrer">Ochish</a>
						<a class="btn btn-default btn-xs" href="/app/rfidenter-zebra">ERP</a>
					</td>
				</tr>
			`);
		} else {
			for (const a of zebraAgents) {
				const device = escapeHtml(a?.device || a?.agent_id || "Zebra");
				const urls = Array.isArray(a?.ui_urls) ? a.ui_urls : [];
				const urlCells = urls
					.map((u) => {
						const href = escapeHtml(String(u || ""));
						return href ? `<div><a href="${href}/" target="_blank" rel="noopener noreferrer">${href}</a></div>` : "";
					})
					.join("");
				const bestUrl = String(urls[0] || "").trim();
				const openHref = bestUrl ? `${escapeHtml(bestUrl)}/` : `${zebraUrl}/`;
				const lastSeen = fmtTime(a?.last_seen);
				$agentsBody.append(`
					<tr>
						<td>${iconHtml("zebra")}</td>
						<td><code>${device}</code></td>
						<td>${urlCells || `<div><a href="${zebraUrl}/" target="_blank" rel="noopener noreferrer">${zebraUrl}</a></div>`}</td>
						<td>${dotHtml(true)}${escapeHtml(lastSeen) || "Online"}</td>
						<td>
							<a class="btn btn-primary btn-xs" href="${openHref}" target="_blank" rel="noopener noreferrer">Ochish</a>
							<a class="btn btn-default btn-xs" href="/app/rfidenter-zebra">ERP</a>
						</td>
					</tr>
				`);
			}
		}

		if (!uhfAgents.length) {
			$agentsBody.append(`<tr><td colspan="5" class="text-muted">UHF agent topilmadi (Node ishlayaptimi?)</td></tr>`);
			return;
		}

		for (const a of uhfAgents) {
			const device = escapeHtml(a?.device || a?.agent_id || "");
			const urls = Array.isArray(a?.ui_urls) ? a.ui_urls : [];
			const urlCells = urls
				.map((u) => {
					const href = escapeHtml(String(u || ""));
					return href ? `<div><a href="${href}/" target="_blank" rel="noopener noreferrer">${href}</a></div>` : "";
				})
				.join("");

			const bestUrl = String(urls[0] || "").trim();
			const lastSeen = fmtTime(a?.last_seen);
			const openHref = bestUrl ? `${escapeHtml(bestUrl)}/` : "";
			const ttlSec = state.ttlSec;

			$agentsBody.append(`
				<tr>
					<td>${iconHtml("uhf")}</td>
					<td><code>${device}</code></td>
					<td>${urlCells || '<span class="text-muted">(yo‘q)</span>'}</td>
					<td>
						${dotHtml(true)}${escapeHtml(lastSeen) || "Online"}${ttlSec ? `<div class="text-muted">TTL: ${escapeHtml(ttlSec)}s</div>` : ""}
					</td>
					<td>
						${openHref ? `<a class="btn btn-primary btn-xs" href="${openHref}" target="_blank" rel="noopener noreferrer">Ochish</a>` : ""}
					</td>
				</tr>
			`);
		}
	}

	async function refreshAgents() {
		try {
			$agentsStatus.text("Yuklanmoqda...");
			const r = await frappe.call("rfidenter.rfidenter.api.list_agents");
			const msg = r?.message;
			if (!msg || msg.ok !== true) throw new Error("Agentlar olinmadi");
			state.agents = Array.isArray(msg.agents) ? msg.agents : [];
			state.ttlSec = Number(msg.ttl_sec || 0) || 0;
			renderDevices();
			$agentsStatus.text("");
		} catch (e) {
			$agentsStatus.text("");
			state.agents = [];
			state.ttlSec = 0;
			renderDevices();
			frappe.msgprint({
				title: "Xatolik",
				message: escapeHtml(e?.message || e),
				indicator: "red",
			});
		}
	}

	function initZebraUi() {
		const url = getZebraBaseUrl();
		$zebraUrl.val(url);
		$zebraOpen.attr("href", `${url}/`);

		$zebraUrl.on("keydown", (e) => {
			if (e.key !== "Enter") return;
			const next = normalizeBaseUrl($zebraUrl.val());
			setZebraBaseUrl(next);
			$zebraOpen.attr("href", `${getZebraBaseUrl()}/`);
			refreshZebra({ quiet: true });
		});

		$body.find(".rfidenter-zebra-test").on("click", () => {
			const next = normalizeBaseUrl($zebraUrl.val());
			setZebraBaseUrl(next);
			$zebraOpen.attr("href", `${getZebraBaseUrl()}/`);
			refreshZebra();
		});
	}

	$body.find(".rfidenter-refresh-agents").on("click", () => {
		refreshZebra({ quiet: true });
		refreshAgents();
	});
	initZebraUi();
	renderDevices();
	refreshZebra({ quiet: true });
	refreshAgents();
};
