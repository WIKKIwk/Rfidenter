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
				<div class="panel-heading"><b>Online agentlar (avto topish)</b></div>
				<div class="panel-body">
					<div class="text-muted" style="margin-bottom: 10px">
						Node agent ERP’ga “heartbeat” yuboradi (<code>register_agent</code>) va shu yerda ko‘rinadi.
						Agent ko‘rinmasa: <a href="/app/rfidenter-auth">Authentication</a> dan token oling va lokal kompyuterda Node’ni ishga tushiring.
					</div>

					<button class="btn btn-default btn-sm rfidenter-refresh-agents">Yangilash</button>
					<span class="text-muted rfidenter-agents-status" style="margin-left: 8px"></span>

					<div class="table-responsive" style="margin-top: 10px">
						<table class="table table-bordered table-hover">
							<thead>
								<tr>
									<th style="width: 180px">Device</th>
									<th>UI URL(lar)</th>
									<th style="width: 160px">Last seen</th>
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

	function renderAgents(list, ttlSec) {
		$agentsBody.empty();
		const agents = Array.isArray(list) ? list : [];
		if (!agents.length) {
			$agentsBody.append(`<tr><td colspan="4" class="text-muted">Agent topilmadi (Node ishlayaptimi?)</td></tr>`);
			return;
		}

		for (const a of agents) {
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

			$agentsBody.append(`
				<tr>
					<td><code>${device}</code></td>
					<td>${urlCells || '<span class="text-muted">(yo‘q)</span>'}</td>
					<td>${escapeHtml(lastSeen)}${ttlSec ? `<div class="text-muted">TTL: ${escapeHtml(ttlSec)}s</div>` : ""}</td>
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
			renderAgents(msg.agents, msg.ttl_sec);
			$agentsStatus.text("");
		} catch (e) {
			$agentsStatus.text("");
			renderAgents([], 0);
			frappe.msgprint({
				title: "Xatolik",
				message: escapeHtml(e?.message || e),
				indicator: "red",
			});
		}
	}

	$body.find(".rfidenter-refresh-agents").on("click", () => refreshAgents());
	refreshAgents();
};
