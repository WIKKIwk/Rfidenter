/* global frappe */

function escapeHtml(value) {
	const s = String(value ?? "");
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function fmtTime(ts) {
	const n = Number(ts);
	if (!Number.isFinite(n) || n <= 0) return "";
	try {
		return new Date(n).toLocaleTimeString();
	} catch {
		return "";
	}
}

function normalizeEpc(epc) {
	return String(epc ?? "")
		.trim()
		.toUpperCase()
		.replace(/[^0-9A-F]/g, "");
}

function formatAnts(antCounts) {
	try {
		const keys = Object.keys(antCounts || {})
			.map((k) => Number(k))
			.filter((n) => Number.isInteger(n) && n > 0)
			.sort((a, b) => a - b);
		if (!keys.length) return "";
		return keys.join(",");
	} catch {
		return "";
	}
}

frappe.pages["rfidenter-live"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "RFIDenter Live",
		single_column: true,
	});

	const state = {
		connected: false,
		lastAt: 0,
		rows: new Map(), // epc -> { epc, count, rssi, antCounts, lastAt, device }
		maxRows: 200,
	};

	const $body = $(`
		<div class="rfidenter-live">
			<div class="alert alert-info" style="margin-bottom: 12px">
				<b>Realtime</b>: bu sahifa Node RFID servisidan kelayotgan taglarni real-time ko‘rsatadi.
				<br />
				Endpoint: <code class="rfidenter-endpoint"></code>
			</div>

			<div class="flex" style="gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px">
				<span class="rfidenter-dot" style="width:10px;height:10px;border-radius:999px;background:#d9d9d9;display:inline-block"></span>
				<span class="rfidenter-status">Ulanmagan</span>
				<span style="margin-left: auto"></span>
				<input class="form-control input-sm rfidenter-filter" style="width: 320px" placeholder="EPC filter (E200...)" />
				<button class="btn btn-default btn-sm rfidenter-clear">Tozalash</button>
			</div>

			<div class="rfidenter-ants" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"></div>

			<div class="table-responsive">
				<table class="table table-bordered table-hover">
					<thead>
						<tr>
							<th style="width: 36px">#</th>
							<th>EPC</th>
							<th style="width: 90px">Count</th>
							<th style="width: 80px">RSSI</th>
							<th style="width: 90px">ANT</th>
							<th style="width: 120px">Device</th>
							<th style="width: 110px">Last</th>
						</tr>
					</thead>
					<tbody class="rfidenter-tbody"></tbody>
				</table>
			</div>
		</div>
	`);

	page.main.append($body);

	const endpoint = `${window.location.origin}/api/method/rfidenter.rfidenter.api.ingest_tags`;
	$body.find(".rfidenter-endpoint").text(endpoint);

	const $dot = $body.find(".rfidenter-dot");
	const $status = $body.find(".rfidenter-status");
	const $tbody = $body.find(".rfidenter-tbody");
	const $filter = $body.find(".rfidenter-filter");
	const $ants = $body.find(".rfidenter-ants");

	function setConnected(on, details) {
		state.connected = Boolean(on);
		$dot.css("background", on ? "#28a745" : "#d9d9d9");
		$status.text(on ? `Ulangan${details ? ` (${details})` : ""}` : "Ulanmagan");
	}

	function renderAntSummary() {
		const antStats = new Map(); // ant -> unique
		for (const r of state.rows.values()) {
			for (const ant of Object.keys(r.antCounts || {})) {
				const a = Number(ant);
				if (!Number.isInteger(a) || a <= 0) continue;
				antStats.set(a, (antStats.get(a) || 0) + 1);
			}
		}
		const ants = [...antStats.entries()].sort((a, b) => a[0] - b[0]);
		$ants.empty();
		if (!ants.length) return;
		for (const [ant, unique] of ants) {
			const badge = $(`
				<span class="badge badge-pill badge-default" style="padding:6px 10px">
					ANT${escapeHtml(ant)}: ${escapeHtml(unique)}
				</span>
			`);
			$ants.append(badge);
		}
	}

	function render() {
		const want = normalizeEpc($filter.val());
		const rows = [...state.rows.values()]
			.filter((r) => (want ? r.epc.includes(want) : true))
			.sort((a, b) => b.lastAt - a.lastAt);

		$tbody.empty();
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			const antLabel = formatAnts(r.antCounts) || "";
			const tr = $(`
				<tr>
					<td>${i + 1}</td>
					<td><code>${escapeHtml(r.epc)}</code></td>
					<td>${escapeHtml(r.count)}</td>
					<td>${escapeHtml(r.rssi ?? "")}</td>
					<td>${escapeHtml(antLabel)}</td>
					<td>${escapeHtml(r.device ?? "")}</td>
					<td>${escapeHtml(fmtTime(r.lastAt))}</td>
				</tr>
			`);
			$tbody.append(tr);
		}

		renderAntSummary();
	}

	function upsertTag({ device, tag, ts }) {
		const epc = normalizeEpc(tag?.epcId);
		if (!epc) return;
		const ant = Number(tag?.antId ?? 0);
		const antKey = Number.isInteger(ant) && ant > 0 ? String(ant) : "";
		const prev = state.rows.get(epc);
		const lastAt = Number(ts) || Date.now();
		const antCounts = prev?.antCounts ? { ...prev.antCounts } : {};
		if (antKey) antCounts[antKey] = (antCounts[antKey] || 0) + 1;
		state.rows.set(epc, {
			epc,
			count: prev ? prev.count + 1 : 1,
			rssi: tag?.rssi ?? prev?.rssi,
			antCounts,
			device: device || prev?.device || "",
			lastAt,
		});

		// Trim old entries
		if (state.rows.size > state.maxRows) {
			const sorted = [...state.rows.values()].sort((a, b) => b.lastAt - a.lastAt);
			state.rows = new Map(sorted.slice(0, state.maxRows).map((x) => [x.epc, x]));
		}
	}

	$body.find(".rfidenter-clear").on("click", () => {
		state.rows.clear();
		render();
	});

	$filter.on("input", () => render());

	// SocketIO realtime events from server-side publish_realtime
	frappe.realtime.on("rfidenter_tag_batch", (payload) => {
		try {
			const device = String(payload?.device || "");
			const ts = payload?.ts;
			const tags = Array.isArray(payload?.tags) ? payload.tags : [];
			for (const tag of tags) upsertTag({ device, tag, ts });
			state.lastAt = Date.now();
			setConnected(true, device);
			render();
		} catch (e) {
			// ignore
		}
	});

	// If no events for a while, mark as disconnected.
	window.setInterval(() => {
		const idleMs = Date.now() - (state.lastAt || 0);
		if (!state.lastAt || idleMs > 8000) setConnected(false);
	}, 1000);

	setConnected(false);
	render();
};
