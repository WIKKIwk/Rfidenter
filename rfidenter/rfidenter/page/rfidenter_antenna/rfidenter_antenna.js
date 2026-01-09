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

function fmtDate(ts) {
	const n = Number(ts);
	if (!Number.isFinite(n) || n <= 0) return "";
	try {
		return new Date(n).toLocaleDateString();
	} catch {
		return "";
	}
}

function dateKey(ts) {
	const n = Number(ts);
	if (!Number.isFinite(n) || n <= 0) return "";
	try {
		return new Date(n).toISOString().slice(0, 10);
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
	if (!Number.isFinite(n)) return 0;
	const v = Math.trunc(n);
	if (v < 0 || v > 31) return 0;
	return v;
}

function truncateText(value, maxLen = 48) {
	const s = String(value ?? "").trim();
	if (!s) return "";
	if (s.length <= maxLen) return s;
	return `${s.slice(0, Math.max(0, maxLen - 3))}...`;
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
		notes: new Map(), // epc -> note
		saved: new Map(), // epc -> { epc, reads, lastAt, device }
		savedLimit: 200,
		savedSort: "last",
		savedMax: 5000,
		savedOpen: true,
		savedDate: "",
		zebraOnly: true,
		zebraEpcs: new Set(),
		zebraReady: false,
		zebraLoading: false,
		zebraLimit: 10000,
		zebraMeta: new Map(),
		zebraMetaQueue: new Set(),
		zebraMetaLoading: false,
		zebraMetaTimer: null,
		zebraMetaLimit: 300,
	};

	const $body = $(`
		<div class="rfidenter-ant">
			<style>
				.rfidenter-ant {
					--rf-card-bg: var(--card-bg, #ffffff);
					--rf-border: var(--border-color, #d1d8dd);
					--rf-border-width: 6px;
					--rf-control: var(--control-bg, #f7f7f7);
					--rf-muted: var(--text-muted, #6b7280);
					--rf-shadow: 0 10px 24px rgba(0, 0, 0, 0.08);
				}
				.rfidenter-ant .rfidenter-toolbar { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
				.rfidenter-ant .rfidenter-status-card {
					display: flex;
					align-items: center;
					gap: 12px;
					padding: 10px 14px;
					border-radius: 12px;
					border: var(--rf-border-width) solid var(--rf-border);
					background: var(--rf-card-bg);
					box-shadow: var(--rf-shadow);
					min-width: 220px;
				}
				.rfidenter-ant .rfidenter-status-card.is-online { border-color: rgba(40, 167, 69, 0.5); }
				.rfidenter-ant .rfidenter-status-card.is-offline { border-color: rgba(220, 53, 69, 0.45); }
				.rfidenter-ant .rfidenter-status-dot {
					width: 12px;
					height: 12px;
					border-radius: 999px;
					background: #b8c0c7;
					box-shadow: 0 0 0 6px rgba(184, 192, 199, 0.16);
				}
				.rfidenter-ant .rfidenter-status-card.is-online .rfidenter-status-dot {
					background: #28a745;
					box-shadow: 0 0 0 6px rgba(40, 167, 69, 0.18);
				}
				.rfidenter-ant .rfidenter-status-card.is-offline .rfidenter-status-dot {
					background: #dc3545;
					box-shadow: 0 0 0 6px rgba(220, 53, 69, 0.16);
				}
				.rfidenter-ant .rfidenter-status-text { font-weight: 600; }
				.rfidenter-ant .rfidenter-status-meta { color: var(--rf-muted); font-size: 12px; }
				.rfidenter-ant .rfidenter-controls { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-left: auto; }
				.rfidenter-ant .rfidenter-control { display: flex; flex-direction: column; gap: 4px; }
				.rfidenter-ant .rfidenter-control label { font-size: 11px; color: var(--rf-muted); margin: 0; }
				.rfidenter-ant .rfidenter-card {
					background: var(--rf-card-bg);
					border: var(--rf-border-width) solid var(--rf-border);
					border-radius: 14px;
					padding: 14px;
					box-shadow: var(--rf-shadow);
				}
				.rfidenter-ant .rfidenter-table-wrap {
					border: var(--rf-border-width) solid var(--rf-border);
					border-radius: 10px;
					overflow: hidden;
					background: var(--rf-card-bg);
				}
				.rfidenter-ant .rfidenter-table thead th { background: var(--rf-control); font-weight: 600; }
				.rfidenter-ant .rfidenter-table td, .rfidenter-ant .rfidenter-table th { vertical-align: middle; }
				.rfidenter-ant .rfidenter-ant-tbody tr { cursor: pointer; }
				.rfidenter-ant .rfidenter-ant-tbody tr.active { background: rgba(66, 133, 244, 0.12); }
				.rfidenter-ant .rfidenter-ant-tbody tr:hover { background: rgba(66, 133, 244, 0.08); }
				.rfidenter-ant .rfidenter-epc-cell { cursor: pointer; }
				.rfidenter-ant .rfidenter-epc-cell:hover { text-decoration: underline; }
				.rfidenter-ant .rfidenter-note-cell { cursor: pointer; }
				.rfidenter-ant .rfidenter-note-cell:hover { background: rgba(15, 23, 42, 0.04); }
				.rfidenter-ant .rfidenter-note-text { color: #4f5b67; font-size: 12px; }
				.rfidenter-ant .rfidenter-note-empty { color: #98a0a6; font-style: italic; }
				.rfidenter-ant .rfidenter-note-pill { background: #eef3ff; border-radius: 999px; padding: 2px 8px; display: inline-block; }
				.rfidenter-ant .rfidenter-reads { font-weight: 600; }
				.rfidenter-ant .rfidenter-se-link { font-weight: 600; color: #2563eb; }
				.rfidenter-ant .rfidenter-se-link:hover { text-decoration: underline; }
				.rfidenter-ant .rfidenter-se-meta { color: var(--rf-muted); font-size: 11px; margin-top: 2px; }
				.rfidenter-ant .rfidenter-se-empty { color: #98a0a6; font-style: italic; font-size: 12px; }
				.rfidenter-ant .rfidenter-ant-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
				.rfidenter-ant .rfidenter-ant-hint { color: var(--rf-muted); font-size: 12px; }
				.rfidenter-ant .rfidenter-saved { margin-top: 16px; }
				.rfidenter-ant .rfidenter-saved.is-collapsed .rfidenter-saved-body { display: none; }
				.rfidenter-ant .rfidenter-saved-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
				.rfidenter-ant .rfidenter-saved-title { font-weight: 600; }
				.rfidenter-ant .rfidenter-saved-actions { display: flex; gap: 8px; align-items: center; }
				.rfidenter-ant .rfidenter-date-input { width: 180px; }
				.rfidenter-ant .rfidenter-pill-btn { border-radius: 999px; padding: 6px 14px; }
			</style>

			<div class="rfidenter-toolbar">
				<div class="rfidenter-status-card is-offline">
					<span class="rfidenter-status-dot"></span>
					<div>
						<div class="rfidenter-status-text">Ulanmagan</div>
						<div class="rfidenter-status-meta">Realtime signal yo‘q</div>
					</div>
				</div>
				<div class="rfidenter-controls">
					<div class="rfidenter-control">
						<label>EPC filter</label>
						<input class="form-control input-sm rfidenter-filter" style="width: 280px" placeholder="E200..." />
					</div>
					<div class="rfidenter-control">
						<label>Saralash</label>
						<select class="form-control input-sm rfidenter-sort" style="width: 200px">
							<option value="count">Reads (desc)</option>
							<option value="last">Last (desc)</option>
							<option value="epc">EPC (A→Z)</option>
						</select>
					</div>
					<button class="btn btn-default btn-sm rfidenter-clear">Tozalash</button>
				</div>
			</div>

			<div class="row" style="margin: 0 -8px">
				<div class="col-md-4" style="padding: 0 8px">
					<div class="rfidenter-card">
						<div style="font-weight:600;margin-bottom:8px">Antenna ro‘yxati</div>
						<div class="rfidenter-table-wrap">
							<div class="table-responsive" style="max-height: 60vh; overflow:auto">
								<table class="table table-bordered table-hover rfidenter-table">
								<thead>
									<tr>
										<th style="width: 44px">#</th>
										<th style="width: 70px">ANT</th>
										<th style="width: 110px">Unique</th>
										<th style="width: 110px">Reads</th>
									</tr>
								</thead>
								<tbody class="rfidenter-ant-tbody"></tbody>
								</table>
							</div>
						</div>
					</div>
				</div>

				<div class="col-md-8" style="padding: 0 8px">
					<div class="rfidenter-card">
						<div class="rfidenter-ant-head">
							<div class="rfidenter-ant-title" style="font-weight:600">ANT1 — taglar</div>
							<div class="rfidenter-ant-hint"></div>
						</div>
						<div class="rfidenter-table-wrap">
							<div class="table-responsive" style="max-height: 60vh; overflow:auto">
								<table class="table table-bordered table-hover rfidenter-table">
								<thead>
									<tr>
										<th style="width: 44px">#</th>
										<th>EPC</th>
										<th style="width: 90px">Reads</th>
										<th style="width: 80px">RSSI</th>
										<th style="width: 120px">Device</th>
										<th style="width: 150px">Stock Entry</th>
										<th style="width: 110px">Last</th>
										<th style="width: 220px">Izoh</th>
									</tr>
								</thead>
								<tbody class="rfidenter-tag-tbody"></tbody>
								</table>
							</div>
						</div>
					</div>
				</div>
			</div>

			<div class="rfidenter-card rfidenter-saved">
				<div class="rfidenter-saved-header">
					<div>
						<div class="rfidenter-saved-title">Saqlangan RFIDlar</div>
						<div class="rfidenter-saved-hint"></div>
					</div>
					<div class="rfidenter-saved-actions">
						<button class="btn btn-default btn-sm rfidenter-pill-btn rfidenter-saved-toggle">Yopish</button>
						<button class="btn btn-danger btn-sm rfidenter-pill-btn rfidenter-saved-clear">Tozalash</button>
					</div>
				</div>
				<div class="rfidenter-saved-body">
					<div class="rfidenter-controls" style="margin: 6px 0 12px">
						<div class="rfidenter-control">
							<label>Kun</label>
							<input class="form-control input-sm rfidenter-date-input rfidenter-saved-date" type="date" />
						</div>
						<div class="rfidenter-control">
							<label>Limit</label>
							<select class="form-control input-sm rfidenter-saved-limit" style="width: 120px">
								<option value="100">100</option>
								<option value="200" selected>200</option>
								<option value="500">500</option>
								<option value="1000">1000</option>
							</select>
						</div>
						<div class="rfidenter-control">
							<label>Saralash</label>
							<select class="form-control input-sm rfidenter-saved-sort" style="width: 200px">
								<option value="last">Last (desc)</option>
								<option value="reads">Reads (desc)</option>
								<option value="epc">EPC (A→Z)</option>
							</select>
						</div>
					</div>
					<div class="rfidenter-table-wrap">
						<div class="table-responsive" style="max-height: 45vh; overflow:auto">
							<table class="table table-bordered table-hover rfidenter-table">
								<thead>
									<tr>
										<th style="width: 44px">#</th>
										<th>EPC</th>
										<th style="width: 110px">Reads</th>
										<th style="width: 120px">Kun</th>
										<th style="width: 110px">Vaqt</th>
										<th style="width: 140px">Device</th>
										<th style="width: 150px">Stock Entry</th>
										<th style="width: 220px">Izoh</th>
									</tr>
								</thead>
								<tbody class="rfidenter-saved-tbody"></tbody>
							</table>
						</div>
					</div>
				</div>
			</div>
		</div>
	`);

	page.main.append($body);

	const $statusCard = $body.find(".rfidenter-status-card");
	const $statusDot = $body.find(".rfidenter-status-dot");
	const $statusText = $body.find(".rfidenter-status-text");
	const $statusMeta = $body.find(".rfidenter-status-meta");
	const $filter = $body.find(".rfidenter-filter");
	const $sort = $body.find(".rfidenter-sort");
	const $antBody = $body.find(".rfidenter-ant-tbody");
	const $tagBody = $body.find(".rfidenter-tag-tbody");
	const $title = $body.find(".rfidenter-ant-title");
	const $hint = $body.find(".rfidenter-ant-hint");
	const $savedBody = $body.find(".rfidenter-saved-tbody");
	const $savedHint = $body.find(".rfidenter-saved-hint");
	const $savedLimit = $body.find(".rfidenter-saved-limit");
	const $savedSort = $body.find(".rfidenter-saved-sort");
	const $savedDate = $body.find(".rfidenter-saved-date");
	const $savedToggle = $body.find(".rfidenter-saved-toggle");
	const $savedClear = $body.find(".rfidenter-saved-clear");
	const $savedCard = $body.find(".rfidenter-saved");
	let notesLoading = false;
	let savedLoading = false;

	async function fetchNotes({ epcs = null, quiet = false } = {}) {
		if (notesLoading) return;
		notesLoading = true;
		try {
			const args = {};
			if (Array.isArray(epcs) && epcs.length) args.epcs = epcs;
			const r = await frappe.call("rfidenter.rfidenter.api.get_tag_notes", args);
			const notes = r?.message?.notes || {};
			for (const [epc, note] of Object.entries(notes)) {
				const n = String(note ?? "").trim();
				if (!epc) continue;
				if (n) state.notes.set(String(epc).toUpperCase(), n);
				else state.notes.delete(String(epc).toUpperCase());
			}
		} catch (e) {
			if (!quiet) {
				frappe.msgprint({
					title: "Xatolik",
					message: escapeHtml(e?.message || e),
					indicator: "red",
				});
			}
		} finally {
			notesLoading = false;
		}
	}

	function getNote(epc) {
		return state.notes.get(String(epc || "").toUpperCase()) || "";
	}

	function buildStockEntryCell(epc) {
		const meta = getZebraMeta(epc);
		if (!meta) {
			const loading = state.zebraMetaLoading || state.zebraMetaQueue.size > 0;
			return `<span class="rfidenter-se-empty">${loading ? "Yuklanmoqda..." : "—"}</span>`;
		}
		const stockEntry = String(meta.stock_entry || "").trim();
		const status = String(meta.status || "").trim();
		const itemCode = String(meta.item_code || "").trim();
		const itemName = String(meta.item_name || "").trim();
		const qty = meta.qty !== undefined && meta.qty !== null ? String(meta.qty) : "";
		const uom = String(meta.uom || "").trim();
		const label = [itemName || itemCode, qty && uom ? `${qty} ${uom}` : ""].filter(Boolean).join(" · ");
		const title = [status ? `Status: ${status}` : "", label ? `Item: ${label}` : ""].filter(Boolean).join("\n");

		if (!stockEntry) {
			return `${status ? `<div class="rfidenter-se-meta" title="${escapeHtml(title)}">${escapeHtml(status)}</div>` : '<span class="rfidenter-se-empty">—</span>'}`;
		}
		const href = `/app/stock-entry/${encodeURIComponent(stockEntry)}`;
		const metaLine = status ? `<div class="rfidenter-se-meta" title="${escapeHtml(title)}">${escapeHtml(status)}</div>` : "";
		return `<a class="rfidenter-se-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(title)}">${escapeHtml(stockEntry)}</a>${metaLine}`;
	}

	function isZebraAllowed(epc) {
		if (!state.zebraOnly) return true;
		if (!state.zebraReady) return false;
		const key = normalizeEpc(epc);
		if (!key) return false;
		return state.zebraEpcs.has(key);
	}

	function pruneToZebraEpcs() {
		if (!state.zebraOnly || !state.zebraReady) return;
		for (const [ant, m] of state.byAnt.entries()) {
			for (const epc of m.keys()) {
				if (!state.zebraEpcs.has(epc)) m.delete(epc);
			}
			if (!m.size) state.byAnt.delete(ant);
		}
		for (const epc of state.saved.keys()) {
			if (!state.zebraEpcs.has(epc)) state.saved.delete(epc);
		}
		for (const epc of state.zebraMeta.keys()) {
			if (!state.zebraEpcs.has(epc)) state.zebraMeta.delete(epc);
		}
		for (const epc of state.zebraMetaQueue.keys()) {
			if (!state.zebraEpcs.has(epc)) state.zebraMetaQueue.delete(epc);
		}
	}

	async function fetchZebraEpcs({ quiet = false } = {}) {
		if (!state.zebraOnly || state.zebraLoading) return;
		state.zebraLoading = true;
		try {
			const r = await frappe.call("rfidenter.rfidenter.api.zebra_list_epcs", {
				statuses: ["Printed", "Processing", "Consumed"],
				limit: state.zebraLimit,
			});
			const msg = r?.message;
			if (!msg || msg.ok !== true) throw new Error("Zebra EPC ro‘yxati olinmadi");
			const list = Array.isArray(msg.epcs) ? msg.epcs : [];
			state.zebraEpcs = new Set(list.map((e) => normalizeEpc(e)).filter(Boolean));
			state.zebraReady = true;
			pruneToZebraEpcs();
			render();
		} catch (e) {
			if (!quiet) {
				frappe.msgprint({
					title: "Zebra filter xatosi",
					message: escapeHtml(e?.message || e),
					indicator: "red",
				});
			}
		} finally {
			state.zebraLoading = false;
		}
	}

	function getZebraMeta(epc) {
		const key = normalizeEpc(epc);
		if (!key) return null;
		return state.zebraMeta.get(key) || null;
	}

	function queueZebraMeta(epcs) {
		if (!state.zebraOnly) return;
		if (!Array.isArray(epcs) || !epcs.length) return;
		for (const epc of epcs) {
			const key = normalizeEpc(epc);
			if (!key || state.zebraMeta.has(key)) continue;
			state.zebraMetaQueue.add(key);
		}
		if (state.zebraMetaQueue.size) scheduleZebraMetaFetch();
	}

	function scheduleZebraMetaFetch() {
		if (state.zebraMetaTimer) return;
		state.zebraMetaTimer = window.setTimeout(() => {
			state.zebraMetaTimer = null;
			fetchZebraMetaBatch().catch(() => {});
		}, 200);
	}

	async function fetchZebraMetaBatch() {
		if (state.zebraMetaLoading || !state.zebraMetaQueue.size) return;
		state.zebraMetaLoading = true;
		try {
			const epcs = [];
			for (const epc of state.zebraMetaQueue) {
				epcs.push(epc);
				if (epcs.length >= state.zebraMetaLimit) break;
			}
			epcs.forEach((epc) => state.zebraMetaQueue.delete(epc));
			if (!epcs.length) return;
			const r = await frappe.call("rfidenter.rfidenter.api.zebra_epc_info", { epcs });
			const items = Array.isArray(r?.message?.items) ? r.message.items : [];
			for (const item of items) {
				const key = normalizeEpc(item?.epc);
				if (!key) continue;
				state.zebraMeta.set(key, {
					epc: key,
					stock_entry: item?.stock_entry || item?.purchase_receipt || "",
					status: item?.status || "",
					item_code: item?.item_code || "",
					item_name: item?.item_name || "",
					qty: item?.qty ?? "",
					uom: item?.uom || "",
				});
			}
			render();
		} finally {
			state.zebraMetaLoading = false;
			if (state.zebraMetaQueue.size) scheduleZebraMetaFetch();
		}
	}

	async function fetchSavedTags({ quiet = false } = {}) {
		if (savedLoading) return;
		savedLoading = true;
		try {
			const r = await frappe.call("rfidenter.rfidenter.api.get_saved_tags", {
				limit: state.savedLimit,
				order: state.savedSort,
				date: state.savedDate || null,
			});
			const items = Array.isArray(r?.message?.items) ? r.message.items : [];
			state.saved.clear();
			for (const item of items) {
				const epc = normalizeEpc(item?.epc);
				if (!isZebraAllowed(epc)) continue;
				if (!epc) continue;
				const reads = Number(item?.reads ?? item?.count ?? 0);
				const lastAt = item?.last_seen ? new Date(item.last_seen).getTime() : 0;
				state.saved.set(epc, {
					epc,
					reads: Number.isFinite(reads) ? reads : 0,
					lastAt: Number.isFinite(lastAt) ? lastAt : 0,
					device: item?.device || "",
				});
			}
			const epcs = items.map((i) => normalizeEpc(i?.epc)).filter(Boolean);
			if (epcs.length) await fetchNotes({ epcs, quiet: true });
			if (epcs.length) queueZebraMeta(epcs);
			renderSaved();
		} catch (e) {
			if (!quiet) {
				frappe.msgprint({
					title: "Xatolik",
					message: escapeHtml(e?.message || e),
					indicator: "red",
				});
			}
		} finally {
			savedLoading = false;
		}
	}

	async function setNote(epc, note) {
		const key = String(epc || "").toUpperCase();
		const next = String(note ?? "").trim();
		if (!key) return;
		try {
			await frappe.call("rfidenter.rfidenter.api.set_tag_note", { epc: key, note: next });
			if (!next) state.notes.delete(key);
			else state.notes.set(key, next);
			render();
		} catch (e) {
			frappe.msgprint({
				title: "Xatolik",
				message: escapeHtml(e?.message || e),
				indicator: "red",
			});
		}
	}

	function editNote(epc) {
		const key = String(epc || "").toUpperCase();
		if (!key) return;
		const current = getNote(key);
		frappe.prompt(
			[
				{
					fieldname: "note",
					fieldtype: "Small Text",
					label: "Izoh",
					default: current,
				},
			],
			(values) => {
				setNote(key, values?.note || "");
			},
			`EPC izohi: ${key}`,
			"Saqlash",
		);
	}

	function setConnected(on, details) {
		state.connected = Boolean(on);
		$statusCard.toggleClass("is-online", on).toggleClass("is-offline", !on);
		$statusDot.css("background", on ? "#28a745" : "#dc3545");
		$statusText.text(on ? "Ulangan" : "Ulanmagan");
		$statusMeta.text(on ? (details ? `Device: ${details}` : "Realtime signal bor") : "Realtime signal yo‘q");
	}

	function upsertTag({ device, tag, ts }) {
		const epc = normalizeEpc(tag?.epcId);
		const ant = clampAnt(tag?.antId ?? 0);
		if (!isZebraAllowed(epc)) return;
		if (!epc || ant <= 0) return;
		queueZebraMeta([epc]);
		const deltaRaw = Number(tag?.count ?? 1);
		const delta = Number.isFinite(deltaRaw) ? Math.max(1, Math.min(1_000_000, Math.trunc(deltaRaw))) : 1;

		if (!state.byAnt.has(ant)) state.byAnt.set(ant, new Map());
		const m = state.byAnt.get(ant);
		const prev = m.get(epc);
		const lastAt = Number(ts) || Date.now();
		m.set(epc, {
			epc,
			count: prev ? prev.count + delta : delta,
			rssi: tag?.rssi ?? prev?.rssi,
			device: device || prev?.device || "",
			lastAt,
		});

		upsertSavedTag({ device, epc, delta, ts: lastAt });

		if (m.size > state.maxPerAnt) {
			const sorted = [...m.values()].sort((a, b) => b.lastAt - a.lastAt);
			const trimmed = new Map(sorted.slice(0, state.maxPerAnt).map((x) => [x.epc, x]));
			state.byAnt.set(ant, trimmed);
		}
	}

	function upsertSavedTag({ device, epc, delta, ts }) {
		if (!isZebraAllowed(epc)) return;
		if (!epc) return;
		const prev = state.saved.get(epc);
		const reads = (prev?.reads || 0) + (delta || 1);
		state.saved.set(epc, {
			epc,
			reads,
			lastAt: Number(ts) || Date.now(),
			device: device || prev?.device || "",
		});
		if (state.saved.size > state.savedMax) trimSaved();
	}

	function trimSaved() {
		const rows = [...state.saved.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
		state.saved = new Map(rows.slice(0, state.savedMax).map((r) => [r.epc, r]));
	}

	function buildSavedRows() {
		const want = normalizeEpc(state.filter);
		const rows = [...state.saved.values()].filter((r) => {
			if (!isZebraAllowed(r.epc)) return false;
			if (want && !r.epc.includes(want)) return false;
			if (state.savedDate) return dateKey(r.lastAt) === state.savedDate;
			return true;
		});
		rows.sort((a, b) => {
			if (state.savedSort === "epc") return String(a.epc).localeCompare(String(b.epc));
			if (state.savedSort === "reads") return (b.reads || 0) - (a.reads || 0);
			return (b.lastAt || 0) - (a.lastAt || 0);
		});
		return rows.slice(0, state.savedLimit);
	}

	function renderSaved() {
		const rows = buildSavedRows();
		if (rows.length) queueZebraMeta(rows.map((r) => r.epc));
		$savedBody.empty();
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			const note = getNote(r.epc);
			const noteShort = truncateText(note, 42);
			const tr = $(`
				<tr>
					<td>${i + 1}</td>
					<td class="rfidenter-epc-cell" data-epc="${escapeHtml(r.epc)}">
						<code>${escapeHtml(r.epc)}</code>
					</td>
					<td class="rfidenter-reads">${escapeHtml(r.reads)}</td>
					<td>${escapeHtml(fmtDate(r.lastAt))}</td>
					<td>${escapeHtml(fmtTime(r.lastAt))}</td>
					<td>${escapeHtml(r.device ?? "")}</td>
					<td>${buildStockEntryCell(r.epc)}</td>
					<td class="rfidenter-note-cell" data-epc="${escapeHtml(r.epc)}">
						${note ? `<span class="rfidenter-note-pill rfidenter-note-text" title="${escapeHtml(note)}">${escapeHtml(noteShort)}</span>` : '<span class="rfidenter-note-empty">Izoh yo‘q</span>'}
					</td>
				</tr>
			`);
			$savedBody.append(tr);
		}
		const dateLabel = state.savedDate ? ` · Kun: ${state.savedDate}` : "";
		$savedHint.text(`Ko‘rsatilmoqda: ${rows.length} ta EPC · Jami: ${state.saved.size}${dateLabel}`);
		$savedBody.find(".rfidenter-epc-cell, .rfidenter-note-cell").on("click", (e) => {
			const epc = String($(e.currentTarget).data("epc") || "").trim();
			if (!epc) return;
			editNote(epc);
		});
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
		if (rows.length) queueZebraMeta(rows.map((r) => r.epc));
		$title.text(`ANT${state.selectedAnt} — taglar`);
		const notesCount = rows.reduce((acc, r) => acc + (getNote(r.epc) ? 1 : 0), 0);
		const zebraInfo = state.zebraOnly
			? state.zebraReady
				? `Zebra EPC: ${state.zebraEpcs.size}`
				: "Zebra EPC: yuklanmoqda"
			: "Filter: All EPC";
		$hint.text(`Ko‘rsatilmoqda: ${rows.length} ta EPC · Izohlar: ${notesCount} · ${zebraInfo}`);

		$tagBody.empty();
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			const note = getNote(r.epc);
			const noteShort = truncateText(note, 42);
			const tr = $(`
				<tr>
					<td>${i + 1}</td>
					<td class="rfidenter-epc-cell" data-epc="${escapeHtml(r.epc)}">
						<code>${escapeHtml(r.epc)}</code>
					</td>
					<td class="rfidenter-reads">${escapeHtml(r.count)}</td>
					<td>${escapeHtml(r.rssi ?? "")}</td>
					<td>${escapeHtml(r.device ?? "")}</td>
					<td>${buildStockEntryCell(r.epc)}</td>
					<td>${escapeHtml(fmtTime(r.lastAt))}</td>
					<td class="rfidenter-note-cell" data-epc="${escapeHtml(r.epc)}">
						${note ? `<span class="rfidenter-note-pill rfidenter-note-text" title="${escapeHtml(note)}">${escapeHtml(noteShort)}</span>` : '<span class="rfidenter-note-empty">Izoh yo‘q</span>'}
					</td>
				</tr>
			`);
			$tagBody.append(tr);
		}

		$tagBody.find(".rfidenter-epc-cell, .rfidenter-note-cell").on("click", (e) => {
			const epc = String($(e.currentTarget).data("epc") || "").trim();
			if (!epc) return;
			editNote(epc);
		});

		renderSaved();
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

	$savedLimit.on("change", () => {
		const next = Number($savedLimit.val() || 200);
		state.savedLimit = Number.isFinite(next) ? Math.max(50, Math.min(2000, next)) : 200;
		fetchSavedTags({ quiet: true });
	});

	$savedSort.on("change", () => {
		state.savedSort = String($savedSort.val() || "last");
		fetchSavedTags({ quiet: true });
	});

	$savedDate.on("change", () => {
		state.savedDate = String($savedDate.val() || "");
		fetchSavedTags({ quiet: true });
	});

	$savedToggle.on("click", () => {
		state.savedOpen = !state.savedOpen;
		$savedCard.toggleClass("is-collapsed", !state.savedOpen);
		$savedToggle.text(state.savedOpen ? "Yopish" : "Ko‘rsatish");
	});

	$savedClear.on("click", () => {
		frappe.confirm("Saqlangan RFIDlarni tozalamoqchimisiz?", () => {
			frappe.confirm("O‘ylab ko‘ring, aminmisiz?", async () => {
				try {
					await frappe.call("rfidenter.rfidenter.api.clear_saved_tags");
					state.saved.clear();
					renderSaved();
				} catch (e) {
					frappe.msgprint({
						title: "Xatolik",
						message: escapeHtml(e?.message || e),
						indicator: "red",
					});
				}
			});
		});
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

	if (state.zebraOnly) {
		window.setInterval(() => fetchZebraEpcs({ quiet: true }), 60000);
	}

	setConnected(false);
	render();

	(async () => {
		if (state.zebraOnly) await fetchZebraEpcs({ quiet: true });
		await fetchNotes({ quiet: true });
		await fetchSavedTags({ quiet: true });
		render();
	})().catch(() => {});
};
