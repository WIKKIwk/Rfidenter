/* global frappe */

function escapeHtml(value) {
	const s = String(value ?? "");
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function normalizeDevice(value) {
	const s = String(value ?? "").trim().toLowerCase();
	return s ? s.slice(0, 64) : "any";
}

function normalizeAnt(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.trunc(n));
}

function fmtAgo(ts) {
	const n = Number(ts);
	if (!Number.isFinite(n) || n <= 0) return "--";
	const diff = Math.max(0, Date.now() - n);
	const sec = Math.round(diff / 1000);
	if (sec < 5) return "hozir";
	if (sec < 60) return `${sec}s oldin`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m oldin`;
	const hrs = Math.round(min / 60);
	if (hrs < 24) return `${hrs} soat oldin`;
	const days = Math.round(hrs / 24);
	return `${days} kun oldin`;
}

function apiCall(method, args) {
	return frappe
		.call({ method, args: args || {} })
		.then((res) => res.message || res)
		.catch((err) => {
			throw err;
		});
}

frappe.pages["rfidenter-flow"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "RFIDenter — Avtomatika",
		single_column: true,
	});

	const state = {
		antennas: [],
		rules: [],
		dnSettings: [],
		ttlSec: 0,
		loading: false,
		error: "",
		lastSync: 0,
		reloadTimer: null,
	};

	const $body = $(
		`<div class="rfidenter-flow">
			<style>
				.rfidenter-flow {
					--rf-card-bg: var(--card-bg, #ffffff);
					--rf-border: var(--border-color, #d1d8dd);
					--rf-muted: var(--text-muted, #6b7280);
					--rf-shadow: var(--shadow-sm, 0 6px 16px rgba(0, 0, 0, 0.06));
				}
				.rfidenter-flow .rf-flow-header {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 12px;
					flex-wrap: wrap;
					margin-bottom: 16px;
				}
				.rfidenter-flow .rf-flow-title {
					font-weight: 600;
					font-size: 18px;
				}
				.rfidenter-flow .rf-flow-sub {
					color: var(--rf-muted);
					font-size: 12px;
					margin-top: 4px;
				}
				.rfidenter-flow .rf-flow-actions {
					display: flex;
					align-items: center;
					gap: 10px;
				}
				.rfidenter-flow .rf-flow-status {
					color: var(--rf-muted);
					font-size: 12px;
				}
				.rfidenter-flow .rf-flow-grid {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
					gap: 16px;
					align-items: start;
				}
				.rfidenter-flow .rf-flow-card {
					background: var(--rf-card-bg);
					border: 1px solid var(--rf-border);
					border-radius: 16px;
					padding: 16px;
					box-shadow: var(--rf-shadow);
					transition: transform 0.2s ease, box-shadow 0.2s ease;
				}
				.rfidenter-flow .rf-flow-card:hover {
					transform: translateY(-1px);
				}
				.rfidenter-flow .rf-flow-card-head {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 8px;
					margin-bottom: 12px;
				}
				.rfidenter-flow .rf-flow-card-title {
					font-weight: 600;
				}
				.rfidenter-flow .rf-flow-card-sub {
					color: var(--rf-muted);
					font-size: 12px;
				}
				.rfidenter-flow .rf-flow-antenna-list,
				.rfidenter-flow .rf-flow-rules-list,
				.rfidenter-flow .rf-flow-dn-list {
					display: flex;
					flex-direction: column;
					gap: 10px;
				}
				.rfidenter-flow .rf-flow-empty {
					color: var(--rf-muted);
					font-size: 12px;
				}
				.rfidenter-flow .rf-flow-ant-row {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 12px;
					padding: 10px 12px;
					border-radius: 12px;
					border: 1px solid var(--rf-border);
					background: var(--control-bg, var(--rf-card-bg));
				}
				.rfidenter-flow .rf-flow-ant-main {
					display: flex;
					flex-direction: column;
					gap: 4px;
					min-width: 0;
				}
				.rfidenter-flow .rf-flow-ant-title {
					font-weight: 600;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
				}
				.rfidenter-flow .rf-flow-ant-sub {
					color: var(--rf-muted);
					font-size: 12px;
				}
				.rfidenter-flow .rf-flow-ant-meta {
					text-align: right;
					font-size: 12px;
					color: var(--rf-muted);
					min-width: 120px;
				}
				.rfidenter-flow .rf-flow-rule-form {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
					gap: 10px;
					align-items: end;
					margin-bottom: 12px;
				}
				.rfidenter-flow .rf-flow-rule-form .control-label {
					font-size: 11px;
					text-transform: uppercase;
					letter-spacing: 0.04em;
					color: var(--rf-muted);
				}
				.rfidenter-flow .rf-flow-rule-actions {
					display: flex;
					gap: 8px;
					align-items: center;
					flex-wrap: wrap;
				}
				.rfidenter-flow .rf-flow-rule-table {
					width: 100%;
					border-collapse: collapse;
					font-size: 13px;
				}
				.rfidenter-flow .rf-flow-rule-table th,
				.rfidenter-flow .rf-flow-rule-table td {
					padding: 8px 10px;
					border-bottom: 1px solid var(--rf-border);
					vertical-align: middle;
				}
				.rfidenter-flow .rf-flow-rule-table th {
					color: var(--rf-muted);
					text-transform: uppercase;
					font-size: 11px;
					letter-spacing: 0.03em;
				}
				.rfidenter-flow .rf-flow-rule-key {
					font-weight: 600;
				}
				.rfidenter-flow .rf-flow-rule-device {
					color: var(--rf-muted);
					font-size: 12px;
				}
				.rfidenter-flow .rf-flow-note {
					color: var(--rf-muted);
					font-size: 12px;
					margin-top: 6px;
				}
				.rfidenter-flow .rf-flow-dn-table {
					width: 100%;
					border-collapse: collapse;
					font-size: 13px;
				}
				.rfidenter-flow .rf-flow-dn-table th,
				.rfidenter-flow .rf-flow-dn-table td {
					padding: 8px 10px;
					border-bottom: 1px solid var(--rf-border);
					vertical-align: top;
				}
				.rfidenter-flow .rf-flow-dn-table th {
					color: var(--rf-muted);
					text-transform: uppercase;
					font-size: 11px;
					letter-spacing: 0.03em;
				}
				.rfidenter-flow .rf-flow-actions-row {
					display: flex;
					gap: 8px;
					flex-wrap: wrap;
					align-items: center;
				}
				@media (max-width: 768px) {
					.rfidenter-flow .rf-flow-ant-row {
						flex-direction: column;
						align-items: flex-start;
					}
					.rfidenter-flow .rf-flow-ant-meta { text-align: left; }
				}
			</style>

			<div class="rf-flow-header">
				<div>
					<div class="rf-flow-title">Antenna avtomatikasi</div>
					<div class="rf-flow-sub">UHF antena o'qiganda Stock Entry va Delivery Note oqimini boshqarish.</div>
				</div>
				<div class="rf-flow-actions">
					<button class="btn btn-default btn-sm rf-flow-refresh">Yangilash</button>
					<span class="rf-flow-status">--</span>
				</div>
			</div>

			<div class="rf-flow-grid">
				<div class="rf-flow-card">
					<div class="rf-flow-card-head">
						<div>
							<div class="rf-flow-card-title">Ulangan antenalar</div>
							<div class="rf-flow-card-sub">Oxirgi ko'rilgan antenna va portlar.</div>
						</div>
						<div class="rf-flow-card-sub rf-flow-ttl">--</div>
					</div>
					<div class="rf-flow-antenna-list"></div>
				</div>

				<div class="rf-flow-card">
					<div class="rf-flow-card-head">
						<div>
							<div class="rf-flow-card-title">Antenna qoidalari</div>
							<div class="rf-flow-card-sub">Har bir portga avtomatika vazifasini belgilang.</div>
						</div>
						<div class="rf-flow-actions-row">
							<button class="btn btn-default btn-xs rf-flow-open-rules">Qoidalar ro'yxati</button>
						</div>
					</div>

					<div class="rf-flow-rule-form">
						<div>
							<div class="control-label">Device</div>
							<input class="form-control input-sm rf-flow-new-device" list="rf-flow-devices" placeholder="any yoki device nomi" />
							<datalist id="rf-flow-devices"></datalist>
						</div>
						<div>
							<div class="control-label">Antenna</div>
							<input class="form-control input-sm rf-flow-new-ant" type="number" min="1" placeholder="1" />
						</div>
						<div>
							<div class="control-label">Stock Entry</div>
							<label class="checkbox">
								<input type="checkbox" class="rf-flow-new-stock" /> Submit
							</label>
						</div>
						<div>
							<div class="control-label">Delivery Note</div>
							<label class="checkbox">
								<input type="checkbox" class="rf-flow-new-dn" /> Draft yaratish
							</label>
						</div>
						<div>
							<div class="control-label">DN Submit</div>
							<label class="checkbox">
								<input type="checkbox" class="rf-flow-new-dn-submit" /> Submit
							</label>
						</div>
						<div>
							<div class="rf-flow-rule-actions">
								<button class="btn btn-primary btn-sm rf-flow-new-save">Saqlash</button>
								<button class="btn btn-default btn-sm rf-flow-new-save-next">Saqlash va keyingisini sozlash</button>
							</div>
						</div>
					</div>

					<div class="rf-flow-note">"Draft yaratish" faqat Stock Entry submit yoqilgan bo'lsa ishlaydi.</div>
					<div class="rf-flow-rules-list"></div>
				</div>
			</div>

			<div class="rf-flow-card" style="margin-top: 16px;">
				<div class="rf-flow-card-head">
					<div>
						<div class="rf-flow-card-title">Delivery Note sozlamalari</div>
						<div class="rf-flow-card-sub">Har bir mahsulot uchun oldindan to'ldiriladigan maydonlar.</div>
					</div>
					<div class="rf-flow-actions-row">
						<button class="btn btn-default btn-xs rf-flow-open-dn">Ro'yxat</button>
						<button class="btn btn-default btn-xs rf-flow-new-dn">Yangi sozlama</button>
					</div>
				</div>
				<div class="rf-flow-dn-list"></div>
			</div>
		</div>`
	);

	page.main.append($body);

	const $status = $body.find(".rf-flow-status");
	const $ttl = $body.find(".rf-flow-ttl");
	const $antList = $body.find(".rf-flow-antenna-list");
	const $rulesList = $body.find(".rf-flow-rules-list");
	const $dnList = $body.find(".rf-flow-dn-list");
	const $deviceList = $body.find("#rf-flow-devices");

	const $newDevice = $body.find(".rf-flow-new-device");
	const $newAnt = $body.find(".rf-flow-new-ant");
	const $newStock = $body.find(".rf-flow-new-stock");
	const $newDn = $body.find(".rf-flow-new-dn");
	const $newDnSubmit = $body.find(".rf-flow-new-dn-submit");

	function renderStatus() {
		if (state.loading) {
			$status.text("Yangilanmoqda...");
			return;
		}
		if (state.error) {
			$status.text(state.error);
			return;
		}
		if (!state.lastSync) {
			$status.text("--");
			return;
		}
		$status.text(`Oxirgi yangilanish: ${fmtAgo(state.lastSync)}`);
	}

	function ruleKey(device, ant) {
		return `${normalizeDevice(device)}:${normalizeAnt(ant)}`;
	}

	function buildRuleMap() {
		const map = new Map();
		state.rules.forEach((rule) => {
			map.set(ruleKey(rule.device, rule.antenna_id), rule);
		});
		return map;
	}

	function summarizeRule(rule) {
		if (!rule) return "Qoidalar yo'q";
		const parts = [];
		if (rule.submit_stock_entry) parts.push("Stock Entry");
		if (rule.create_delivery_note) parts.push("DN draft");
		if (rule.submit_delivery_note) parts.push("DN submit");
		return parts.length ? parts.join(" + ") : "Qoidalar yo'q";
	}

	function renderAntennas() {
		const ttl = state.ttlSec ? `${state.ttlSec}s TTL` : "";
		$ttl.text(ttl ? `TTL: ${ttl}` : "");

		if (!state.antennas.length) {
			$antList.html('<div class="rf-flow-empty">Hozircha antenna ma\'lumotlari yo\'q.</div>');
			return;
		}

		const rulesMap = buildRuleMap();
		const rows = state.antennas
			.map((ant) => {
				const key = ruleKey(ant.device, ant.ant_id);
				const anyKey = ruleKey("any", ant.ant_id);
				const rule = rulesMap.get(key) || rulesMap.get(anyKey);
				const summary = summarizeRule(rule);
				return `
					<div class="rf-flow-ant-row">
						<div class="rf-flow-ant-main">
							<div class="rf-flow-ant-title">${escapeHtml(ant.device || "unknown")} · ANT${ant.ant_id}</div>
							<div class="rf-flow-ant-sub">${summary}</div>
						</div>
						<div class="rf-flow-ant-meta">
							<div>Reads: ${ant.reads || 0}</div>
							<div>${fmtAgo(ant.last_seen)}</div>
						</div>
					</div>`;
			})
			.join("");
		$antList.html(rows);
	}

	function renderRules() {
		if (!state.rules.length) {
			$rulesList.html('<div class="rf-flow-empty">Qoidalar hozircha yo\'q. Yuqoridan yangi qoida qo\'shing.</div>');
			return;
		}

		const rows = state.rules
			.map((rule) => {
				const device = escapeHtml(rule.device || "any");
				const ant = rule.antenna_id || 0;
				const stockChecked = rule.submit_stock_entry ? "checked" : "";
				const dnChecked = rule.create_delivery_note ? "checked" : "";
				const dnSubmitChecked = rule.submit_delivery_note ? "checked" : "";
				const disableDn = rule.submit_stock_entry ? "" : "disabled";
				return `
					<tr data-device="${device}" data-ant="${ant}">
						<td>
							<div class="rf-flow-rule-key">ANT${ant}</div>
							<div class="rf-flow-rule-device">${device}</div>
						</td>
						<td><input type="checkbox" class="rf-flow-rule-toggle" data-field="submit_stock_entry" ${stockChecked} /></td>
						<td><input type="checkbox" class="rf-flow-rule-toggle" data-field="create_delivery_note" ${dnChecked} ${disableDn} /></td>
						<td><input type="checkbox" class="rf-flow-rule-toggle" data-field="submit_delivery_note" ${dnSubmitChecked} /></td>
						<td><button class="btn btn-default btn-xs rf-flow-rule-save">Saqlash</button></td>
					</tr>`;
			})
			.join("");

		$rulesList.html(`
			<div style="overflow-x:auto;">
				<table class="rf-flow-rule-table">
					<thead>
						<tr>
							<th>Device / Antenna</th>
							<th>Stock Entry</th>
							<th>DN draft</th>
							<th>DN submit</th>
							<th></th>
						</tr>
					</thead>
					<tbody>${rows}</tbody>
				</table>
			</div>
		`);
	}

	function renderDnSettings() {
		if (!state.dnSettings.length) {
			$dnList.html('<div class="rf-flow-empty">Delivery Note sozlamalari yo\'q.</div>');
			return;
		}

		const rows = state.dnSettings
			.map((row) => {
				const rate =
					row.default_rate === null || row.default_rate === undefined ? "--" : row.default_rate;
				return `
					<tr>
						<td>${escapeHtml(row.item_code || "--")}</td>
						<td>${escapeHtml(row.customer || "--")}</td>
						<td>${escapeHtml(row.company || "--")}</td>
						<td>${escapeHtml(row.warehouse || "--")}</td>
						<td>${escapeHtml(row.selling_price_list || "--")}</td>
						<td>${escapeHtml(rate)}</td>
					</tr>`;
			})
			.join("");

		$dnList.html(`
			<div style="overflow-x:auto;">
				<table class="rf-flow-dn-table">
					<thead>
						<tr>
							<th>Item</th>
							<th>Customer</th>
							<th>Company</th>
							<th>Warehouse</th>
							<th>Price list</th>
							<th>Default rate</th>
						</tr>
					</thead>
					<tbody>${rows}</tbody>
				</table>
			</div>
		`);
	}

	function updateDeviceList() {
		const devices = Array.from(
			new Set(state.antennas.map((ant) => String(ant.device || "").trim()).filter(Boolean))
		);
		devices.sort();
		$deviceList.empty();
		$deviceList.append('<option value="any"></option>');
		devices.forEach((device) => {
			$deviceList.append(`<option value="${escapeHtml(device)}"></option>`);
		});
	}

	function renderAll() {
		renderStatus();
		renderAntennas();
		renderRules();
		renderDnSettings();
		updateDeviceList();
	}

	function fetchStats() {
		return apiCall("rfidenter.rfidenter.api.list_antenna_stats").then((res) => {
			if (res && res.ok) {
				state.antennas = res.antennas || [];
				state.ttlSec = res.ttl_sec || 0;
			} else {
				state.antennas = [];
				state.ttlSec = 0;
			}
		});
	}

	function fetchRules() {
		return apiCall("rfidenter.rfidenter.api.list_antenna_rules").then((res) => {
			if (res && res.ok) {
				state.rules = res.rules || [];
			} else {
				state.rules = [];
			}
		});
	}

	function fetchDnSettings() {
		return apiCall("rfidenter.rfidenter.api.list_delivery_note_settings").then((res) => {
			if (res && res.ok) {
				state.dnSettings = res.items || [];
			} else {
				state.dnSettings = [];
			}
		});
	}

	async function refreshAll({ toast = false } = {}) {
		state.loading = true;
		state.error = "";
		renderStatus();
		try {
			await Promise.all([fetchStats(), fetchRules(), fetchDnSettings()]);
			state.lastSync = Date.now();
			if (toast) {
				frappe.show_alert({ message: "Yangilandi", indicator: "green" });
			}
		} catch (err) {
			state.error = "Yangilashda xato";
		}
		state.loading = false;
		renderAll();
	}

	function setDnToggleState($stock, $dn) {
		const enabled = $stock.prop("checked");
		if (!enabled) {
			$dn.prop("checked", false);
		}
		$dn.prop("disabled", !enabled);
	}

	$body.on("change", ".rf-flow-rule-table .rf-flow-rule-toggle", function () {
		const $row = $(this).closest("tr");
		const $stock = $row.find("input[data-field='submit_stock_entry']");
		const $dn = $row.find("input[data-field='create_delivery_note']");
		setDnToggleState($stock, $dn);
	});

	$body.on("click", ".rf-flow-rule-save", async function () {
		const $row = $(this).closest("tr");
		const device = $row.data("device") || "any";
		const ant = Number($row.data("ant")) || 0;
		const submitStock = $row.find("input[data-field='submit_stock_entry']").prop("checked");
		const createDn = $row.find("input[data-field='create_delivery_note']").prop("checked");
		const submitDn = $row.find("input[data-field='submit_delivery_note']").prop("checked");

		if (!ant) {
			frappe.msgprint("Antenna raqami noto'g'ri.");
			return;
		}

		const $btn = $(this);
		$btn.prop("disabled", true);
		try {
			await apiCall("rfidenter.rfidenter.api.upsert_antenna_rule", {
				device,
				antenna_id: ant,
				submit_stock_entry: submitStock,
				create_delivery_note: createDn,
				submit_delivery_note: submitDn,
			});
			frappe.show_alert({ message: "Qoida saqlandi", indicator: "green" });
			await fetchRules();
			renderAll();
		} catch (err) {
			frappe.msgprint("Qoida saqlanmadi.");
		}
		$btn.prop("disabled", false);
	});

	$body.on("click", ".rf-flow-new-save", async function () {
		await handleNewRuleSave({ advance: false, button: $(this) });
	});

	$body.on("click", ".rf-flow-new-save-next", async function () {
		await handleNewRuleSave({ advance: true, button: $(this) });
	});

	async function handleNewRuleSave({ advance, button }) {
		const deviceRaw = $newDevice.val() || "any";
		const ant = normalizeAnt($newAnt.val());
		if (!ant) {
			frappe.msgprint("Antenna raqamini kiriting.");
			return;
		}
		const submitStock = $newStock.prop("checked");
		const createDn = $newDn.prop("checked");
		const submitDn = $newDnSubmit.prop("checked");

		button.prop("disabled", true);
		try {
			await apiCall("rfidenter.rfidenter.api.upsert_antenna_rule", {
				device: deviceRaw,
				antenna_id: ant,
				submit_stock_entry: submitStock,
				create_delivery_note: createDn,
				submit_delivery_note: submitDn,
			});
			frappe.show_alert({ message: "Yangi qoida qo'shildi", indicator: "green" });
			if (advance) {
				$newAnt.val(String(ant + 1));
				$newAnt.trigger("focus");
			} else {
				$newAnt.val("");
			}
			await fetchRules();
			renderAll();
		} catch (err) {
			frappe.msgprint("Qoida saqlanmadi.");
		}
		button.prop("disabled", false);
	}

	$body.on("click", ".rf-flow-open-rules", () => {
		frappe.set_route("List", "RFID Antenna Rule");
	});

	$body.on("click", ".rf-flow-open-dn", () => {
		frappe.set_route("List", "RFID Delivery Note Setting");
	});

	$body.on("click", ".rf-flow-new-dn", () => {
		frappe.new_doc("RFID Delivery Note Setting");
	});

	$body.on("change", ".rf-flow-new-stock", () => setDnToggleState($newStock, $newDn));
	setDnToggleState($newStock, $newDn);

	$body.find(".rf-flow-refresh").on("click", () => refreshAll({ toast: true }));

	refreshAll();
	state.reloadTimer = setInterval(() => refreshAll(), 15000);
};
