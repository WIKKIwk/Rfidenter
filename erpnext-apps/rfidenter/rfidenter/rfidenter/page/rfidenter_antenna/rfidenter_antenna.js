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

function clampAnt(raw) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return 1;
	const v = Math.trunc(n);
	return v < 1 ? 1 : v > 31 ? 31 : v;
}

frappe.pages["rfidenter-antenna"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "RFIDenter — Antenna",
		single_column: true,
	});

	const state = {
		connected: false,
		lastAt: 0,
		selectedAnt: 1,
		filter: "",
		sort: "count",
		byAnt: new Map(), // ant -> Map(epc -> row)
		maxPerAnt: 1200,
	};

	const $body = $(`
		<div class="rfidenter-ant">
			<div class="alert alert-info" style="margin-bottom: 12px">
				<b>Antenna bo‘yicha</b>: har bir antennada qaysi taglar (EPC) ko‘ringanini ko‘rsatadi.
				<br />
				Eslatma: server tomonda EPC+ANT dedup yoqilgan bo‘lsa, <b>bitta EPC bitta antennada 1 marta</b> keladi.
			</div>

			<div class="flex" style="gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px">
				<span class="rfidenter-dot" style="width:10px;height:10px;border-radius:999px;background:#d9d9d9;display:inline-block"></span>
				<span class="rfidenter-status">Ulanmagan</span>
				<span style="margin-left: auto"></span>
				<input class="form-control input-sm rfidenter-filter" style="width: 320px" placeholder="EPC filter (E200...)" />
				<select class="form-control input-sm rfidenter-sort" style="width: 200px">
					<option value="count">Count (desc)</option>
					<option value="last">Last (desc)</option>
					<option value="epc">EPC (A→Z)</option>
				</select>
				<button class="btn btn-default btn-sm rfidenter-clear">Tozalash</button>
			</div>

			<div class="row" style="margin: 0 -8px">
				<div class="col-md-4" style="padding: 0 8px">
					<div class="panel panel-default" style="padding: 12px">
						<div style="font-weight:600;margin-bottom:8px">Antenna ro‘yxati</div>
						<div class="table-responsive" style="max-height: 60vh; overflow:auto">
							<table class="table table-bordered table-hover">
								<thead>
									<tr>
										<th style="width: 44px">#</th>
										<th style="width: 70px">ANT</th>
										<th style="width: 110px">Unique</th>
										<th style="width: 110px">Count</th>
									</tr>
								</thead>
								<tbody class="rfidenter-ant-tbody"></tbody>
							</table>
						</div>
					</div>
				</div>

				<div class="col-md-8" style="padding: 0 8px">
					<div class="panel panel-default" style="padding: 12px">
						<div class="rfidenter-ant-title" style="font-weight:600;margin-bottom:8px">ANT1 — taglar</div>
						<div class="text-muted rfidenter-ant-hint" style="margin-bottom:8px"></div>
						<div class="table-responsive" style="max-height: 60vh; overflow:auto">
							<table class="table table-bordered table-hover">
								<thead>
									<tr>
										<th style="width: 44px">#</th>
										<th>EPC</th>
										<th style="width: 90px">Count</th>
										<th style="width: 80px">RSSI</th>
										<th style="width: 120px">Device</th>
										<th style="width: 110px">Last</th>
									</tr>
								</thead>
								<tbody class="rfidenter-tag-tbody"></tbody>
							</table>
						</div>
					</div>
				</div>
			</div>
		</div>
	`);

	page.main.append($body);

	const $dot = $body.find(".rfidenter-dot");
	const $status = $body.find(".rfidenter-status");
	const $filter = $body.find(".rfidenter-filter");
	const $sort = $body.find(".rfidenter-sort");
	const $antBody = $body.find(".rfidenter-ant-tbody");
	const $tagBody = $body.find(".rfidenter-tag-tbody");
	const $title = $body.find(".rfidenter-ant-title");
	const $hint = $body.find(".rfidenter-ant-hint");

	function setConnected(on, details) {
		state.connected = Boolean(on);
		$dot.css("background", on ? "#28a745" : "#d9d9d9");
		$status.text(on ? `Ulangan${details ? ` (${details})` : ""}` : "Ulanmagan");
	}

	function upsertTag({ device, tag, ts }) {
		const epc = normalizeEpc(tag?.epcId);
		const ant = clampAnt(tag?.antId ?? 0);
		if (!epc) return;

		if (!state.byAnt.has(ant)) state.byAnt.set(ant, new Map());
		const m = state.byAnt.get(ant);
		const prev = m.get(epc);
		const lastAt = Number(ts) || Date.now();
		m.set(epc, {
			epc,
			count: prev ? prev.count + 1 : 1,
			rssi: tag?.rssi ?? prev?.rssi,
			device: device || prev?.device || "",
			lastAt,
		});

		if (m.size > state.maxPerAnt) {
			const sorted = [...m.values()].sort((a, b) => b.lastAt - a.lastAt);
			const trimmed = new Map(sorted.slice(0, state.maxPerAnt).map((x) => [x.epc, x]));
			state.byAnt.set(ant, trimmed);
		}
	}

	function buildAntRows() {
		const ants = [...state.byAnt.entries()].map(([ant, m]) => {
			let reads = 0;
			for (const r of m.values()) reads += Number(r.count || 0);
			return { ant, unique: m.size, reads };
		});
		ants.sort((a, b) => b.reads - a.reads);
		return ants;
	}

	function buildDetailRows() {
		const ant = state.selectedAnt;
		const m = state.byAnt.get(ant) || new Map();
		const want = normalizeEpc(state.filter);
		const rows = [...m.values()].filter((r) => (want ? r.epc.includes(want) : true));
		rows.sort((a, b) => {
			if (state.sort === "epc") return String(a.epc).localeCompare(String(b.epc));
			if (state.sort === "last") return b.lastAt - a.lastAt;
			return b.count - a.count;
		});
		return rows;
	}

	function render() {
		const antRows = buildAntRows();
		$antBody.empty();
		for (let i = 0; i < antRows.length; i++) {
			const r = antRows[i];
			const active = r.ant === state.selectedAnt ? "active" : "";
			const tr = $(`
				<tr class="${active}" data-ant="${r.ant}">
					<td>${i + 1}</td>
					<td><b>ANT${escapeHtml(r.ant)}</b></td>
					<td>${escapeHtml(r.unique)}</td>
					<td>${escapeHtml(r.reads)}</td>
				</tr>
			`);
			$antBody.append(tr);
		}

		$antBody.find("tr").on("click", (e) => {
			const ant = clampAnt($(e.currentTarget).data("ant"));
			state.selectedAnt = ant;
			render();
		});

		const rows = buildDetailRows();
		$title.text(`ANT${state.selectedAnt} — taglar`);
		$hint.text(`Ko‘rsatilmoqda: ${rows.length} ta EPC`);

		$tagBody.empty();
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			const tr = $(`
				<tr>
					<td>${i + 1}</td>
					<td><code>${escapeHtml(r.epc)}</code></td>
					<td>${escapeHtml(r.count)}</td>
					<td>${escapeHtml(r.rssi ?? "")}</td>
					<td>${escapeHtml(r.device ?? "")}</td>
					<td>${escapeHtml(fmtTime(r.lastAt))}</td>
				</tr>
			`);
			$tagBody.append(tr);
		}
	}

	$body.find(".rfidenter-clear").on("click", () => {
		state.byAnt.clear();
		render();
	});

	$filter.on("input", () => {
		state.filter = String($filter.val() || "");
		render();
	});

	$sort.on("change", () => {
		state.sort = String($sort.val() || "count");
		render();
	});

	frappe.realtime.on("rfidenter_tag_batch", (payload) => {
		try {
			const device = String(payload?.device || "");
			const ts = payload?.ts;
			const tags = Array.isArray(payload?.tags) ? payload.tags : [];
			for (const tag of tags) upsertTag({ device, tag, ts });
			state.lastAt = Date.now();
			setConnected(true, device);
			render();
		} catch {
			// ignore
		}
	});

	window.setInterval(() => {
		const idleMs = Date.now() - (state.lastAt || 0);
		if (!state.lastAt || idleMs > 8000) setConnected(false);
	}, 1000);

	setConnected(false);
	render();
};

