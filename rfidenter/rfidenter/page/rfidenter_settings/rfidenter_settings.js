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

function isLoopbackUrl(raw) {
	try {
		const u = new URL(String(raw || ""));
		const host = String(u.hostname || "").trim().toLowerCase();
		return host === "127.0.0.1" || host === "localhost" || host === "::1";
	} catch {
		return false;
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

	const $body = $(`
		<div class="rfidenter-settings">
			<style>
				.rfidenter-settings {
					--rf-card-bg: var(--card-bg, #ffffff);
					--rf-border: var(--border-color, #d1d8dd);
					--rf-muted: var(--text-muted, #6b7280);
					--rf-shadow: var(--shadow-sm, 0 6px 16px rgba(0, 0, 0, 0.08));
				}
				.rfidenter-settings .rfidenter-panel .panel-body { display: flex; flex-direction: column; gap: 10px; }
				.rfidenter-settings .rfidenter-info-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
				.rfidenter-settings .rfidenter-label { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--rf-muted); }
				.rfidenter-settings .rfidenter-note { color: var(--rf-muted); font-size: 12px; }
				.rfidenter-settings details.rfidenter-advanced summary { cursor: pointer; color: var(--rf-muted); }
				.rfidenter-settings details.rfidenter-advanced[open] summary { margin-bottom: 6px; }
				.rfidenter-settings .rfidenter-zebra-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
				.rfidenter-settings .rfidenter-pill-btn { border-radius: 999px; padding: 6px 14px; }
				.rfidenter-settings .rfidenter-device-list { display: grid; gap: 12px; margin-top: 12px; }
				.rfidenter-settings .rfidenter-device-card {
					background: var(--rf-card-bg);
					border: 1px solid var(--rf-border);
					border-radius: 16px;
					padding: 12px 14px;
					display: flex;
					gap: 12px;
					align-items: stretch;
					box-shadow: var(--rf-shadow);
				}
				.rfidenter-settings .rfidenter-device-icon {
					width: 44px;
					height: 44px;
					border-radius: 14px;
					display: flex;
					align-items: center;
					justify-content: center;
					font-size: 16px;
					color: var(--text-color, #1f2937);
					background: var(--control-bg, var(--rf-card-bg));
					border: 1px solid var(--rf-border);
					flex: 0 0 auto;
				}
				.rfidenter-settings .rfidenter-device-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
				.rfidenter-settings .rfidenter-device-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
				.rfidenter-settings .rfidenter-device-name { font-weight: 600; }
				.rfidenter-settings .rfidenter-device-sub { color: var(--rf-muted); font-size: 12px; }
				.rfidenter-settings .rfidenter-device-urls a { display: inline-flex; gap: 6px; }
				.rfidenter-settings .rfidenter-device-urls div { margin-bottom: 2px; }
				.rfidenter-settings .rfidenter-muted { color: var(--rf-muted); font-size: 12px; }
				.rfidenter-settings .rfidenter-status-block { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
				.rfidenter-settings .rfidenter-status-pill {
					display: inline-flex;
					align-items: center;
					gap: 6px;
					padding: 4px 10px;
					border-radius: 999px;
					font-size: 12px;
					font-weight: 600;
					background: var(--control-bg, var(--rf-card-bg));
					color: var(--text-color, #1f2937);
					border: 1px solid var(--rf-border);
				}
				.rfidenter-settings .rfidenter-status-hint { color: var(--rf-muted); font-size: 11px; text-align: right; }
				.rfidenter-settings .rfidenter-device-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
				.rfidenter-settings .rfidenter-empty-card { color: var(--rf-muted); font-size: 12px; }
				@media (max-width: 768px) {
					.rfidenter-settings .rfidenter-device-card { flex-direction: column; }
					.rfidenter-settings .rfidenter-status-block { align-items: flex-start; }
				}
			</style>

			<div class="panel panel-default">
				<div class="panel-heading"><b>Token</b></div>
				<div class="panel-body">
					<div class="rfidenter-info-row">
						<span class="rfidenter-label">ERP URL</span>
						<code class="rfidenter-url"></code>
					</div>
					<div class="rfidenter-info-row">
						<button class="btn btn-primary btn-sm rfidenter-token-generate rfidenter-pill-btn">Token yaratish</button>
						<span class="rfidenter-muted rfidenter-token-status"></span>
					</div>
					<div class="rfidenter-info-row">
						<span class="rfidenter-label">User Token (browser-local)</span>
						<code class="rfidenter-user-token">--</code>
					</div>
					<div class="rfidenter-info-row">
						<span class="rfidenter-label">Site Token (server config, effective)</span>
						<code class="rfidenter-site-token">--</code>
					</div>
				</div>
			</div>

			<div class="panel panel-default rfidenter-panel" style="margin-top: 12px">
				<div class="panel-heading"><b>Online qurilmalar</b></div>
				<div class="panel-body">
					<div class="rfidenter-note">Ulangan qurilmalarni shu yerda ko'rasiz.</div>

					<div class="rfidenter-zebra-row">
						<label class="rfidenter-label" style="margin: 0">Zebra URL</label>
						<input class="form-control input-sm rfidenter-zebra-url" style="width: 360px" placeholder="http://127.0.0.1:18000" />
						<button class="btn btn-default btn-sm rfidenter-zebra-test rfidenter-pill-btn">Tekshirish</button>
						<a class="btn btn-default btn-sm rfidenter-zebra-open rfidenter-pill-btn" target="_blank" rel="noopener noreferrer">UI</a>
						<span class="rfidenter-zebra-status"></span>
					</div>

					<div class="rfidenter-zebra-row" style="margin-top: 6px">
						<button class="btn btn-default btn-sm rfidenter-refresh-agents rfidenter-pill-btn">Yangilash</button>
						<span class="rfidenter-muted rfidenter-agents-status"></span>
					</div>

					<div class="rfidenter-device-list"></div>
				</div>
			</div>
		</div>
	`);

	page.main.append($body);
	setText($body.find(".rfidenter-url"), origin);

	const $agentsStatus = $body.find(".rfidenter-agents-status");
	const $agentsBody = $body.find(".rfidenter-device-list");
	const $zebraUrl = $body.find(".rfidenter-zebra-url");
	const $zebraOpen = $body.find(".rfidenter-zebra-open");
	const $zebraStatus = $body.find(".rfidenter-zebra-status");
	const $tokenStatus = $body.find(".rfidenter-token-status");
	const $userTokenLine = $body.find(".rfidenter-user-token");
	const $siteTokenLine = $body.find(".rfidenter-site-token");
	const $tokenBtn = $body.find(".rfidenter-token-generate");

	const state = {
		agents: [],
		ttlSec: 0,
		zebra: { ok: false, message: "", checkedAt: 0 },
	};

	function getStoredAuth() {
		return String(window.localStorage.getItem(STORAGE_AUTH) || "").trim();
	}

	function renderUserToken(auth) {
		const value = String(auth || "").trim();
		setText($userTokenLine, value || "not set");
	}

	async function refreshSiteTokenStatus({ quiet = false } = {}) {
		const hasSystemManager =
			frappe.session?.user === "Administrator" || (frappe.user && frappe.user.has_role("System Manager"));
		if (!hasSystemManager) {
			setText($siteTokenLine, "not authorized (System Manager only)");
			return;
		}
		try {
			const r = await frappe.call("rfidenter.rfidenter.api.get_site_token_status");
			const msg = r?.message;
			if (!msg || msg.ok !== true) throw new Error("Token status olinmadi");
			if (typeof msg.has_site_token !== "boolean" || typeof msg.source !== "string") {
				throw new Error("Token status noto‘g‘ri");
			}
			if (!msg.has_site_token) {
				setText($siteTokenLine, "not set");
				return;
			}
			const source = String(msg.source || "").trim() || "default";
			const masked = String(msg.masked || "").trim();
			setText($siteTokenLine, masked ? `${masked} (source: ${source})` : `not set (source: ${source})`);
		} catch (e) {
			const excType = String(e?.exc_type || e?.exc || "").trim();
			const message = String(e?.message || e || "").trim();
			const isPermission = excType === "PermissionError" || message.toLowerCase().includes("permission");
			if (isPermission) {
				setText($siteTokenLine, "not authorized");
			} else if (!$siteTokenLine.text()) {
				setText($siteTokenLine, "error/unavailable");
			}
			if (!quiet && !isPermission) {
				frappe.show_alert({ message: `Site token: ${escapeHtml(e?.message || e)}`, indicator: "orange" });
			}
		}
	}

	function getZebraBaseUrl() {
		return normalizeBaseUrl(window.localStorage.getItem(STORAGE_ZEBRA_URL) || DEFAULT_ZEBRA_URL) || DEFAULT_ZEBRA_URL;
	}

	function setZebraBaseUrl(url) {
		window.localStorage.setItem(STORAGE_ZEBRA_URL, normalizeBaseUrl(url));
	}

	function iconHtml(type) {
		const kind = type === "zebra" ? "zebra" : "uhf";
		const icon = kind === "zebra" ? "fa-print" : "fa-rss";
		const title = kind === "zebra" ? "Zebra" : "UHF";
		return `<span class="rfidenter-device-icon ${kind}" title="${title}"><i class="fa ${icon}"></i></span>`;
	}

	function isZebraAgent(agent) {
		const kind = String(agent?.kind || "").trim().toLowerCase();
		if (kind === "zebra") return true;
		const agentId = String(agent?.agent_id || "").trim().toLowerCase();
		const version = String(agent?.version || "").trim().toLowerCase();
		return agentId.startsWith("zebra") || version.includes("zebra");
	}

	function statusHtml({ ok, text, hint }) {
		const cls = ok ? "ok" : "off";
		const hintHtml = hint ? `<div class="rfidenter-status-hint">${escapeHtml(hint)}</div>` : "";
		return `<div class="rfidenter-status-block"><span class="rfidenter-status-pill ${cls}">${escapeHtml(text)}</span>${hintHtml}</div>`;
	}

	function urlsHtml(urls, fallbackUrl) {
		const list = Array.isArray(urls) ? urls : [];
		const cells = list
			.map((u) => {
				const href = escapeHtml(String(u || ""));
				return href ? `<div><a href="${href}/" target="_blank" rel="noopener noreferrer">${href}</a></div>` : "";
			})
			.join("");
		if (cells) return cells;
		if (fallbackUrl) {
			const href = escapeHtml(String(fallbackUrl || ""));
			return href ? `<div><a href="${href}/" target="_blank" rel="noopener noreferrer">${href}</a></div>` : "";
		}
		return '<span class="rfidenter-muted">--</span>';
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

	function loopbackZebraAgentBaseUrl(agents) {
		const list = Array.isArray(agents) ? agents : [];
		for (const a of list) {
			if (!isZebraAgent(a)) continue;
			const urls = Array.isArray(a?.ui_urls) ? a.ui_urls : [];
			for (const u of urls) {
				const base = normalizeBaseUrl(u);
				if (base && isLoopbackUrl(base)) return base;
			}
		}
		return "";
	}

	async function trySyncZebraUrlFromAgent({ quiet = false } = {}) {
		const current = getZebraBaseUrl();
		if (!isLoopbackUrl(current)) return false;

		let agents = state.agents;
		try {
			const r = await frappe.call("rfidenter.rfidenter.api.list_agents");
			const msg = r?.message;
			if (msg && msg.ok === true) {
				agents = Array.isArray(msg.agents) ? msg.agents : [];
				state.agents = agents;
				state.ttlSec = Number(msg.ttl_sec || 0) || 0;
			}
		} catch {
			// ignore
		}

		const baseFromAgent = loopbackZebraAgentBaseUrl(agents);
		if (!baseFromAgent) return false;
		if (normalizeBaseUrl(baseFromAgent) === normalizeBaseUrl(current)) return false;

		setZebraBaseUrl(baseFromAgent);
		const next = getZebraBaseUrl();
		$zebraUrl.val(next);
		$zebraOpen.attr("href", `${next}/`);
		if (!quiet) frappe.show_alert({ message: `Zebra URL yangilandi: ${escapeHtml(baseFromAgent)}`, indicator: "orange" });
		return true;
	}

	async function refreshZebra({ quiet = false } = {}) {
		let baseUrl = getZebraBaseUrl();
		$zebraStatus.html(statusHtml({ ok: true, text: "Tekshirilmoqda..." }));
		try {
			const data = await zebraGet("/api/v1/health");
			if (data?.ok !== true) throw new Error("Zebra health not ok");
			state.zebra = { ok: true, message: "Online", checkedAt: Date.now() };
			$zebraStatus.html(statusHtml({ ok: true, text: "Online" }));
			$zebraOpen.attr("href", `${baseUrl}/`);
		} catch (e) {
			let err = e;

			try {
				const changed = await trySyncZebraUrlFromAgent({ quiet: true });
				if (changed) {
					baseUrl = getZebraBaseUrl();
					try {
						const data2 = await zebraGet("/api/v1/health");
						if (data2?.ok !== true) throw new Error("Zebra health not ok");
						state.zebra = { ok: true, message: "Online", checkedAt: Date.now() };
						$zebraStatus.html(statusHtml({ ok: true, text: "Online" }));
						$zebraOpen.attr("href", `${baseUrl}/`);
						err = null;
					} catch (e2) {
						err = e2;
					}
				}
			} catch {
				// ignore
			}

			if (err) {
				state.zebra = { ok: false, message: String(err?.message || err), checkedAt: Date.now() };
				$zebraStatus.html(statusHtml({ ok: false, text: "Offline", hint: state.zebra.message }));
				$zebraOpen.attr("href", `${baseUrl}/`);
				if (!quiet) {
					frappe.show_alert({ message: `Zebra: ${escapeHtml(err?.message || err)}`, indicator: "orange" });
				}
			}
		}
		renderDevices();
	}

	async function generateToken() {
		try {
			$tokenStatus.text("Yaratilmoqda...");
			const r = await frappe.call("rfidenter.rfidenter.api.generate_user_token", { rotate: 1 });
			if (!r || !r.message || r.message.ok !== true) throw new Error("Token yaratilmadi");
			const auth = String(r.message.authorization || "").trim();
			if (auth) window.localStorage.setItem(STORAGE_AUTH, auth);
			renderUserToken(auth);
			$tokenStatus.text("Tayyor");
			window.setTimeout(() => setText($tokenStatus, ""), 2500);
			refreshSiteTokenStatus({ quiet: true });
		} catch (e) {
			$tokenStatus.text("");
			frappe.msgprint({
				title: "Xatolik",
				message: escapeHtml(e?.message || e),
				indicator: "red",
			});
		}
	}

	function renderDevices() {
		$agentsBody.empty();
		const zebraUrl = getZebraBaseUrl();
		const zebraUrlEsc = escapeHtml(zebraUrl);
		const agents = Array.isArray(state.agents) ? state.agents : [];
		const zebraAgents = agents.filter((a) => isZebraAgent(a));
		const uhfAgents = agents.filter((a) => !isZebraAgent(a));

		if (!zebraAgents.length) {
			const zebraOk = Boolean(state.zebra.ok);
			const zebraStatus = statusHtml({
				ok: zebraOk,
				text: zebraOk ? "Local OK" : "Offline",
				hint: zebraOk ? "Local UI" : state.zebra.message || "Agent offline",
			});
			$agentsBody.append(`
				<div class="rfidenter-device-card">
					${iconHtml("zebra")}
					<div class="rfidenter-device-main">
						<div class="rfidenter-device-header">
							<div>
								<div class="rfidenter-device-name">Zebra</div>
								<div class="rfidenter-device-sub">USB printer (local)</div>
							</div>
							${zebraStatus}
						</div>
						<div class="rfidenter-device-urls">${urlsHtml([], zebraUrl)}</div>
					</div>
					<div class="rfidenter-device-actions">
						<a class="btn btn-primary btn-xs rfidenter-pill-btn" href="${zebraUrlEsc}/" target="_blank" rel="noopener noreferrer">Ochish</a>
						<a class="btn btn-default btn-xs rfidenter-pill-btn" href="/app/rfidenter-zebra">ERP</a>
					</div>
				</div>
			`);
		} else {
			for (const a of zebraAgents) {
				const device = escapeHtml(a?.device || a?.agent_id || "Zebra");
				const urls = Array.isArray(a?.ui_urls) ? a.ui_urls : [];
				const bestUrl = String(urls[0] || "").trim();
				const openHref = bestUrl ? `${escapeHtml(bestUrl)}/` : `${zebraUrlEsc}/`;
				const lastSeen = fmtTime(a?.last_seen);
				const zebraStatus = statusHtml({
					ok: true,
					text: lastSeen || "Online",
					hint: "Agent heartbeat",
				});
				$agentsBody.append(`
					<div class="rfidenter-device-card">
						${iconHtml("zebra")}
						<div class="rfidenter-device-main">
							<div class="rfidenter-device-header">
								<div>
									<div class="rfidenter-device-name">${device}</div>
									<div class="rfidenter-device-sub">Zebra agent</div>
								</div>
								${zebraStatus}
							</div>
							<div class="rfidenter-device-urls">${urlsHtml(urls, zebraUrl)}</div>
						</div>
						<div class="rfidenter-device-actions">
							<a class="btn btn-primary btn-xs rfidenter-pill-btn" href="${openHref}" target="_blank" rel="noopener noreferrer">Ochish</a>
							<a class="btn btn-default btn-xs rfidenter-pill-btn" href="/app/rfidenter-zebra">ERP</a>
						</div>
					</div>
				`);
			}
		}

		if (!uhfAgents.length) {
			$agentsBody.append(`
				<div class="rfidenter-device-card">
					${iconHtml("uhf")}
					<div class="rfidenter-device-main">
						<div class="rfidenter-device-header">
							<div>
								<div class="rfidenter-device-name">UHF agent topilmadi</div>
								<div class="rfidenter-device-sub">Node agent ishga tushmagan bo'lishi mumkin</div>
							</div>
							${statusHtml({ ok: false, text: "Offline" })}
						</div>
						<div class="rfidenter-device-urls"><span class="rfidenter-muted">URL yo'q</span></div>
					</div>
				</div>
			`);
			return;
		}

		for (const a of uhfAgents) {
			const device = escapeHtml(a?.device || a?.agent_id || "");
			const urls = Array.isArray(a?.ui_urls) ? a.ui_urls : [];
			const bestUrl = String(urls[0] || "").trim();
			const lastSeen = fmtTime(a?.last_seen);
			const openHref = bestUrl ? `${escapeHtml(bestUrl)}/` : "";
			const ttlSec = state.ttlSec;

			const uhfStatus = statusHtml({
				ok: true,
				text: lastSeen || "Online",
				hint: ttlSec ? `TTL ${ttlSec}s` : "",
			});
			$agentsBody.append(`
				<div class="rfidenter-device-card">
					${iconHtml("uhf")}
					<div class="rfidenter-device-main">
						<div class="rfidenter-device-header">
							<div>
								<div class="rfidenter-device-name">${device}</div>
								<div class="rfidenter-device-sub">UHF reader</div>
							</div>
							${uhfStatus}
						</div>
						<div class="rfidenter-device-urls">${urlsHtml(urls, "")}</div>
					</div>
					<div class="rfidenter-device-actions">
						${openHref ? `<a class="btn btn-primary btn-xs rfidenter-pill-btn" href="${openHref}" target="_blank" rel="noopener noreferrer">Ochish</a>` : ""}
					</div>
				</div>
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
			$agentsStatus.text("Yangilandi");
			window.setTimeout(() => setText($agentsStatus, ""), 2500);
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
	$tokenBtn.on("click", () => {
		generateToken();
	});
	initZebraUi();
	renderDevices();
	renderUserToken(getStoredAuth());
	refreshSiteTokenStatus({ quiet: true });
	refreshZebra({ quiet: true });
	refreshAgents();

	window.addEventListener("focus", () => refreshSiteTokenStatus({ quiet: true }));
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) refreshSiteTokenStatus({ quiet: true });
	});
};
