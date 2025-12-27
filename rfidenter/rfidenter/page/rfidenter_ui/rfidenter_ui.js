/* global frappe */

function normalizeUrl(raw) {
	const s = String(raw ?? "").trim();
	if (!s) return "";
	return s.endsWith("/") ? s.slice(0, -1) : s;
}

function escapeHtml(value) {
	const s = String(value ?? "");
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

frappe.pages["rfidenter-ui"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "RFIDenter UI",
		single_column: true,
	});

	const STORAGE_KEY = "rfidenter.node_ui_url";
	const defaultUrl = "http://127.0.0.1:8787";

	function getUrl() {
		return normalizeUrl(window.localStorage.getItem(STORAGE_KEY) || defaultUrl) || defaultUrl;
	}

	function setUrl(url) {
		window.localStorage.setItem(STORAGE_KEY, normalizeUrl(url));
	}

	const $body = $(`
		<div class="rfidenter-ui">
			<div class="alert alert-info" style="margin-bottom: 12px">
				<b>Local RFID UI</b>: bu sahifa Node dasturining (localhost) web interfeysini ERP ichida ko‘rsatadi.
				<br />
				Agar iframe ochilmasa: Node servis ishga tushganini tekshiring (default: <code>${escapeHtml(
					defaultUrl
				)}</code>).
			</div>

			<div class="flex" style="gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px">
				<label class="text-muted" style="margin: 0">Node URL</label>
				<input class="form-control input-sm rfidenter-node-url" style="width: 420px" />
				<button class="btn btn-primary btn-sm rfidenter-load">Ochish</button>
				<a class="btn btn-default btn-sm rfidenter-open" target="_blank" rel="noopener noreferrer">Yangi tab</a>
				<span class="text-muted" style="margin-left: auto">
					Realtime taglar ERP ichida: <a href="/app/rfidenter-live">rfidenter-live</a>
				</span>
			</div>

			<div class="rfidenter-frame-wrap" style="border: 1px solid var(--border-color, #d1d8dd); border-radius: 8px; overflow: hidden">
				<iframe class="rfidenter-frame" style="width: 100%; height: calc(100vh - 260px); border: 0; background: #fff"></iframe>
			</div>
		</div>
	`);

	page.main.append($body);

	const $input = $body.find(".rfidenter-node-url");
	const $frame = $body.find(".rfidenter-frame");
	const $open = $body.find(".rfidenter-open");

	function load(url) {
		const u = normalizeUrl(url) || defaultUrl;
		$input.val(u);
		$frame.attr("src", `${u}/`);
		$open.attr("href", `${u}/`);
		setUrl(u);
	}

	$body.find(".rfidenter-load").on("click", () => load($input.val()));
	$input.on("keydown", (e) => {
		if (e.key === "Enter") load($input.val());
	});

	load(getUrl());
};

