/* global frappe */

function escapeHtml(value) {
	const s = String(value ?? "");
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function clampInt(raw, { min = 0, max = 999999, fallback = 0 } = {}) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeEpc(epc) {
	return String(epc ?? "")
		.trim()
		.toUpperCase()
		.replace(/[^0-9A-F]/g, "");
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

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

frappe.pages["rfidenter-remote"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "RFIDenter Remote",
		single_column: true,
	});

	const STORAGE_AGENT = "rfidenter.remote.agent_id";

	const state = {
		agentId: window.localStorage.getItem(STORAGE_AGENT) || "",
		agents: [],
		pending: new Map(), // request_id -> {resolve, reject, timeout}
		tags: new Map(), // epc -> row
		totalReads: 0,
		maxRows: 300,
	};

	const $body = $(`
		<div class="rfidenter-remote">
			<div class="alert alert-info" style="margin-bottom: 12px">
				<b>Remote UI (URLsiz)</b>: brauzer faqat ERP domeniga ulanadi. Reader ulangan kompyuter esa Node agent orqali ERP’ga token bilan chiqadi
				va buyruqlarni bajaradi.
			</div>

			<div class="panel panel-default">
				<div class="panel-heading"><b>Agent tanlash</b></div>
				<div class="panel-body">
					<div class="flex" style="gap: 10px; align-items: center; flex-wrap: wrap">
						<select class="form-control input-sm rfidenter-agent" style="width: 360px"></select>
						<button class="btn btn-default btn-sm rfidenter-refresh">Yangilash</button>
						<span class="rfidenter-agent-hint text-muted"></span>
					</div>
					<div class="text-muted" style="margin-top: 8px">
						Agar agent ko‘rinmasa: lokal kompyuterda Node’ni ishga tushiring va <code>ERP_PUSH_URL</code> + <code>ERP_PUSH_AUTH</code> ni qo‘ying.
						(<a href="/app/rfidenter-settings">Token / Settings</a>)
					</div>
				</div>
			</div>

			<div class="row" style="margin: 0">
				<div class="col-sm-6" style="padding-left: 0">
					<div class="panel panel-default">
						<div class="panel-heading"><b>Ulanish</b></div>
						<div class="panel-body">
							<div class="form-group">
								<label>Ulanish turi</label>
								<select class="form-control input-sm rfidenter-mode">
									<option value="tcp">TCP/IP (LAN)</option>
									<option value="serial">USB/Serial (RS232)</option>
								</select>
							</div>

							<div class="rfidenter-tcp">
								<div class="form-group">
									<label>IP</label>
									<input class="form-control input-sm rfidenter-ip" placeholder="192.168.0.20" />
								</div>
								<div class="form-group">
									<label>Port</label>
									<input class="form-control input-sm rfidenter-port" value="27011" />
								</div>
								<button class="btn btn-default btn-sm rfidenter-scan">Tarmoq skan</button>
							</div>

							<div class="rfidenter-serial" style="display:none">
								<div class="form-group">
									<label>USB/Serial port</label>
									<div class="flex" style="gap: 10px">
										<input class="form-control input-sm rfidenter-serial-dev" placeholder="/dev/ttyUSB0 yoki COM3" />
										<button class="btn btn-default btn-sm rfidenter-serial-list">Ro‘yxat</button>
									</div>
								</div>
								<div class="form-group">
									<label>Baud</label>
									<input class="form-control input-sm rfidenter-serial-baud" value="57600" />
									<div class="text-muted">57600 / 115200. <b>0</b> — auto.</div>
								</div>
							</div>

							<div class="form-group">
								<label>Antenna soni (UI)</label>
								<select class="form-control input-sm rfidenter-reader-type">
									<option value="4">4 antenna</option>
									<option value="8">8 antenna</option>
									<option value="16" selected>16 antenna</option>
								</select>
							</div>

							<div class="form-group">
								<label>SDK debug log</label>
								<select class="form-control input-sm rfidenter-log-switch">
									<option value="0" selected>O‘chiq</option>
									<option value="1">Yoqiq</option>
								</select>
							</div>

							<div class="flex" style="gap:10px; flex-wrap: wrap">
								<button class="btn btn-primary btn-sm rfidenter-connect">Ulanish</button>
								<button class="btn btn-default btn-sm rfidenter-disconnect">Uzish</button>
								<button class="btn btn-default btn-sm rfidenter-status">Status</button>
							</div>

							<pre class="rfidenter-status-out" style="margin-top:10px; white-space: pre-wrap; max-height: 220px; overflow:auto"></pre>
						</div>
					</div>
				</div>

				<div class="col-sm-6" style="padding-right: 0">
					<div class="panel panel-default">
						<div class="panel-heading"><b>Inventar (scan)</b></div>
						<div class="panel-body">
							<div class="form-group">
								<label>Q (0..15)</label>
								<select class="form-control input-sm rfidenter-q"></select>
							</div>
							<div class="form-group">
								<label>Session</label>
								<select class="form-control input-sm rfidenter-session">
									<option value="255" selected>AUTO (255)</option>
									<option value="0">S0</option>
									<option value="1">S1</option>
									<option value="2">S2</option>
									<option value="3">S3</option>
									<option value="254">AUTO-2 (254)</option>
								</select>
							</div>
							<div class="form-group">
								<label>Target</label>
								<select class="form-control input-sm rfidenter-target">
									<option value="0" selected>A</option>
									<option value="1">B</option>
								</select>
							</div>
							<div class="form-group">
								<label>Skan vaqti (x100ms)</label>
								<input class="form-control input-sm rfidenter-scan-time" value="20" />
								<div class="text-muted">20 = 2 soniya.</div>
							</div>

							<div class="form-group">
								<label>Antenna (mask)</label>
								<div class="rfidenter-ant-list" style="display:flex; gap:8px; flex-wrap: wrap"></div>
								<div class="text-muted">Tanlansa mask avtomatik hisoblanadi.</div>
							</div>

							<div class="flex" style="gap:10px; flex-wrap: wrap">
								<button class="btn btn-primary btn-sm rfidenter-inv-start">Boshlash</button>
								<button class="btn btn-default btn-sm rfidenter-inv-stop">To‘xtatish</button>
								<button class="btn btn-default btn-sm rfidenter-inv-clear">Tozalash</button>
							</div>

							<div class="text-muted" style="margin-top:8px">
								Unique: <b class="rfidenter-uniq">0</b> · Reads: <b class="rfidenter-total">0</b> · Last: <code class="rfidenter-last">-</code>
							</div>
						</div>
					</div>
				</div>
			</div>

			<div class="panel panel-default">
				<div class="panel-heading"><b>Realtime taglar</b></div>
				<div class="panel-body">
					<div class="flex" style="gap:10px; align-items:center; flex-wrap: wrap; margin-bottom: 10px">
						<input class="form-control input-sm rfidenter-filter" style="width: 320px" placeholder="EPC filter (E200...)" />
						<span class="text-muted" style="margin-left:auto">Event: <code>rfidenter_tag_batch</code></span>
					</div>
					<div class="table-responsive">
						<table class="table table-bordered table-hover">
							<thead>
								<tr>
									<th style="width:36px">#</th>
									<th>EPC</th>
									<th style="width:90px">Reads</th>
									<th style="width:80px">RSSI</th>
									<th style="width:70px">ANT</th>
									<th style="width:110px">Last</th>
								</tr>
							</thead>
							<tbody class="rfidenter-tbody"></tbody>
						</table>
					</div>
				</div>
			</div>
		</div>
	`);

	page.main.append($body);

	// Populate Q select
	const $q = $body.find(".rfidenter-q");
	for (let i = 0; i <= 15; i++) {
		$q.append(`<option value="${i}" ${i === 6 ? "selected" : ""}>${i}</option>`);
	}

	const $agent = $body.find(".rfidenter-agent");
	const $agentHint = $body.find(".rfidenter-agent-hint");
	const $mode = $body.find(".rfidenter-mode");
	const $tcp = $body.find(".rfidenter-tcp");
	const $serial = $body.find(".rfidenter-serial");
	const $statusOut = $body.find(".rfidenter-status-out");
	const $tbody = $body.find(".rfidenter-tbody");
	const $filter = $body.find(".rfidenter-filter");
	const $uniq = $body.find(".rfidenter-uniq");
	const $total = $body.find(".rfidenter-total");
	const $last = $body.find(".rfidenter-last");
	const $antList = $body.find(".rfidenter-ant-list");

	function currentAgent() {
		return String(state.agentId || "").trim();
	}

	function setAgent(agentId) {
		state.agentId = String(agentId || "").trim();
		window.localStorage.setItem(STORAGE_AGENT, state.agentId);
		renderAgentHint();
	}

	function renderAgentHint() {
		const id = currentAgent();
		if (!id) {
			$agentHint.text("Agent tanlanmagan");
			return;
		}
		const a = state.agents.find((x) => String(x?.agent_id || x?.device || "") === id);
		const lastSeen = a?.last_seen ? fmtTime(a.last_seen) : "";
		$agentHint.text(lastSeen ? `Online (${lastSeen})` : "Tanlandi");
	}

	function setStatusOut(obj) {
		$statusOut.text(obj ? JSON.stringify(obj, null, 2) : "");
	}

	function renderAgents() {
		$agent.empty();
		$agent.append(`<option value="">— agent tanlang —</option>`);
		for (const a of state.agents) {
			const id = String(a?.agent_id || a?.device || "").trim();
			if (!id) continue;
			const label = `${id}${a?.platform ? ` (${a.platform})` : ""}`;
			$agent.append(`<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`);
		}
		if (state.agentId) $agent.val(state.agentId);
		renderAgentHint();
	}

	async function refreshAgents() {
		try {
			const r = await frappe.call("rfidenter.rfidenter.api.list_agents");
			const msg = r?.message;
			if (!msg || msg.ok !== true) throw new Error("Agentlar olinmadi");
			state.agents = Array.isArray(msg.agents) ? msg.agents : [];
			renderAgents();
		} catch (e) {
			state.agents = [];
			renderAgents();
			frappe.msgprint({
				title: "Xatolik",
				message: escapeHtml(e?.message || e),
				indicator: "red",
			});
		}
	}

	function antCount() {
		return clampInt($body.find(".rfidenter-reader-type").val(), { min: 1, max: 16, fallback: 16 });
	}

	function computeAntennaMask() {
		const checks = $antList.find("input[type=checkbox]");
		let mask = 0;
		checks.each(function () {
			const n = Number($(this).attr("data-ant") || 0);
			if (!Number.isFinite(n) || n <= 0) return;
			if (this.checked) mask |= 1 << (n - 1);
		});
		return mask;
	}

	function renderAntennaChecks() {
		$antList.empty();
		const count = antCount();
		for (let i = 1; i <= count; i++) {
			const id = `rfidenter_ant_${i}`;
			const el = $(`
				<label class="checkbox-inline" style="margin-right: 6px">
					<input id="${id}" type="checkbox" data-ant="${i}" ${i === 1 ? "checked" : ""} />
					ANT${i}
				</label>
			`);
			el.find("input").on("change", () => {
				// no-op: mask computed on demand
			});
			$antList.append(el);
		}
	}

	function getConnectArgs() {
		const mode = String($mode.val() || "tcp");
		return {
			mode: mode === "serial" ? "serial" : "tcp",
			ip: String($body.find(".rfidenter-ip").val() || "").trim(),
			port: clampInt($body.find(".rfidenter-port").val(), { min: 1, max: 65535, fallback: 27011 }),
			device: String($body.find(".rfidenter-serial-dev").val() || "").trim(),
			baud: clampInt($body.find(".rfidenter-serial-baud").val(), { min: 0, max: 10000000, fallback: 57600 }),
			readerType: antCount(),
			logSwitch: clampInt($body.find(".rfidenter-log-switch").val(), { min: 0, max: 1, fallback: 0 }),
		};
	}

	function getInvParams() {
		return {
			ivtType: 0,
			memory: 1,
			invPwd: "00000000",
			qValue: clampInt($q.val(), { min: 0, max: 15, fallback: 6 }),
			session: clampInt($body.find(".rfidenter-session").val(), { min: 0, max: 255, fallback: 255 }),
			scanTime: clampInt($body.find(".rfidenter-scan-time").val(), { min: 1, max: 255, fallback: 20 }),
			antennaMask: computeAntennaMask(),
			tidPtr: 0,
			tidLen: 0,
			target: clampInt($body.find(".rfidenter-target").val(), { min: 0, max: 1, fallback: 0 }),
			retryCount: 5,
		};
	}

	async function agentCall(command, args, { timeoutMs = 30000 } = {}) {
		const agentId = currentAgent();
		if (!agentId) throw new Error("Agent tanlang.");

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

			// Fallback poll (in case socket is not connected)
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

	// Realtime: resolve pending requests instantly
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

	function upsertTag({ tag, ts }) {
		const epc = normalizeEpc(tag?.epcId);
		if (!epc) return;
		const delta = clampInt(tag?.count ?? 1, { min: 1, max: 1_000_000, fallback: 1 });
		const prev = state.tags.get(epc);
		const lastAt = Number(ts) || Date.now();
		state.totalReads += delta;
		state.tags.set(epc, {
			epc,
			count: prev ? prev.count + delta : delta,
			rssi: tag?.rssi ?? prev?.rssi,
			antId: tag?.antId ?? prev?.antId,
			lastAt,
		});
		if (state.tags.size > state.maxRows) {
			const sorted = [...state.tags.values()].sort((a, b) => b.lastAt - a.lastAt);
			state.tags = new Map(sorted.slice(0, state.maxRows).map((x) => [x.epc, x]));
		}
		$uniq.text(String(state.tags.size));
		$total.text(String(state.totalReads));
		$last.text(epc);
	}

	function renderTags() {
		const want = normalizeEpc($filter.val());
		const rows = [...state.tags.values()]
			.filter((r) => (want ? r.epc.includes(want) : true))
			.sort((a, b) => b.lastAt - a.lastAt);

		$tbody.empty();
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			$tbody.append(`
				<tr>
					<td>${i + 1}</td>
					<td><code>${escapeHtml(r.epc)}</code></td>
					<td>${escapeHtml(r.count)}</td>
					<td>${escapeHtml(r.rssi ?? "")}</td>
					<td>${escapeHtml(r.antId ?? "")}</td>
					<td>${escapeHtml(fmtTime(r.lastAt))}</td>
				</tr>
			`);
		}
	}

	$filter.on("input", () => renderTags());

	frappe.realtime.on("rfidenter_tag_batch", (payload) => {
		try {
			// Filter by selected agent (device)
			const device = String(payload?.device || "").trim();
			const agentId = currentAgent();
			if (agentId && device && device !== agentId) return;
			const ts = payload?.ts;
			const tags = Array.isArray(payload?.tags) ? payload.tags : [];
			for (const tag of tags) upsertTag({ tag, ts });
			renderTags();
		} catch {
			// ignore
		}
	});

	function updateModeUi() {
		const mode = String($mode.val() || "tcp");
		if (mode === "serial") {
			$tcp.hide();
			$serial.show();
		} else {
			$serial.hide();
			$tcp.show();
		}
	}

	$mode.on("change", updateModeUi);
	updateModeUi();

	$body.find(".rfidenter-reader-type").on("change", () => renderAntennaChecks());
	renderAntennaChecks();

	$agent.on("change", () => setAgent($agent.val()));
	$body.find(".rfidenter-refresh").on("click", () => refreshAgents());

	$body.find(".rfidenter-status").on("click", async () => {
		try {
			const reply = await agentCall("STATUS", {}, { timeoutMs: 15000 });
			setStatusOut(reply);
		} catch (e) {
			frappe.msgprint({ title: "Xatolik", message: escapeHtml(e?.message || e), indicator: "red" });
		}
	});

	$body.find(".rfidenter-connect").on("click", async () => {
		try {
			setStatusOut(null);
			const args = getConnectArgs();
			if (args.mode === "tcp" && !args.ip) throw new Error("IP kiritilmagan.");
			if (args.mode === "serial" && !args.device) throw new Error("USB/Serial port kiritilmagan.");
			const reply = await agentCall("CONNECT", args, { timeoutMs: 20000 });
			setStatusOut(reply);
			frappe.show_alert({ message: "Ulandi", indicator: "green" });
		} catch (e) {
			frappe.msgprint({ title: "Ulanish xatosi", message: escapeHtml(e?.message || e), indicator: "red" });
		}
	});

	$body.find(".rfidenter-disconnect").on("click", async () => {
		try {
			const reply = await agentCall("DISCONNECT", {}, { timeoutMs: 15000 });
			setStatusOut(reply);
			frappe.show_alert({ message: "Uzildi", indicator: "green" });
		} catch (e) {
			frappe.msgprint({ title: "Xatolik", message: escapeHtml(e?.message || e), indicator: "red" });
		}
	});

	$body.find(".rfidenter-serial-list").on("click", async () => {
		try {
			const reply = await agentCall("LIST_SERIAL", {}, { timeoutMs: 15000 });
			setStatusOut(reply);
		} catch (e) {
			frappe.msgprint({ title: "Xatolik", message: escapeHtml(e?.message || e), indicator: "red" });
		}
	});

	$body.find(".rfidenter-scan").on("click", async () => {
		try {
			const port = clampInt($body.find(".rfidenter-port").val(), { min: 1, max: 65535, fallback: 27011 });
			const reply = await agentCall("SCAN_TCP", { ports: [port, 27011, 2022] }, { timeoutMs: 25000 });
			setStatusOut(reply);
			const first = Array.isArray(reply?.result?.devices) ? reply.result.devices[0] : null;
			if (first?.ip) $body.find(".rfidenter-ip").val(first.ip);
			if (first?.port) $body.find(".rfidenter-port").val(String(first.port));
		} catch (e) {
			frappe.msgprint({ title: "Skan xatosi", message: escapeHtml(e?.message || e), indicator: "red" });
		}
	});

	$body.find(".rfidenter-inv-start").on("click", async () => {
		try {
			const params = getInvParams();
			await agentCall("SET_INV_PARAM", params, { timeoutMs: 15000 });
			await agentCall("START_READ", {}, { timeoutMs: 15000 });
			frappe.show_alert({ message: "Skan boshlandi", indicator: "green" });
		} catch (e) {
			frappe.msgprint({ title: "Skan xatosi", message: escapeHtml(e?.message || e), indicator: "red" });
		}
	});

	$body.find(".rfidenter-inv-stop").on("click", async () => {
		try {
			await agentCall("STOP_READ", {}, { timeoutMs: 15000 });
			frappe.show_alert({ message: "Skan to‘xtadi", indicator: "green" });
		} catch (e) {
			frappe.msgprint({ title: "Xatolik", message: escapeHtml(e?.message || e), indicator: "red" });
		}
	});

	$body.find(".rfidenter-inv-clear").on("click", () => {
		state.tags.clear();
		state.totalReads = 0;
		$uniq.text("0");
		$total.text("0");
		$last.text("-");
		renderTags();
	});

	refreshAgents();
	renderTags();
};
