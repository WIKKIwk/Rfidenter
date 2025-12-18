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

function setCode($el, text) {
	$el.text(String(text ?? ""));
}

frappe.pages["rfidenter-auth"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "RFIDenter — Authentication",
		single_column: true,
	});

	const origin = normalizeBaseUrl(window.location.origin);
	const ingestEndpoint = `${origin}/api/method/rfidenter.rfidenter.api.ingest_tags`;

	const $body = $(`
		<div class="rfidenter-auth">
			<div class="alert alert-info" style="margin-bottom: 12px">
				<b>Authentication (token)</b>: lokal kompyuterdagi Node RFID agent ushbu ERP’ga taglarni yuborishi uchun user token kerak.
			</div>

			<div class="panel panel-default">
				<div class="panel-heading"><b>Token</b></div>
				<div class="panel-body">
					<div style="margin-bottom: 8px"><span class="text-muted">ERP URL:</span> <code class="rfidenter-url"></code></div>
					<div style="margin-bottom: 8px"><span class="text-muted">Ingest endpoint:</span> <code class="rfidenter-endpoint"></code></div>

					<div class="text-muted" style="margin: 10px 0">
						Token faqat <b>RFIDer</b> roli berilgan user uchun ishlaydi. Secret faqat generatsiya paytida ko‘rinadi.
					</div>

					<button class="btn btn-primary btn-sm rfidenter-generate">Token yaratish / yangilash</button>
					<span class="text-muted rfidenter-gen-status" style="margin-left: 8px"></span>

					<div style="margin-top: 12px">
						<div><span class="text-muted">Authorization:</span></div>
						<pre class="rfidenter-auth-line" style="white-space: pre-wrap"></pre>
					</div>

					<div style="margin-top: 10px">
						<div><span class="text-muted">Node konfiguratsiya (copy/paste):</span></div>
						<pre class="rfidenter-env" style="white-space: pre-wrap"></pre>
					</div>
				</div>
			</div>

			<div class="alert alert-warning" style="margin-top: 12px">
				<b>Eslatma</b>: ERP serverda bo‘lsa, reader USB/Serial faqat local kompyuterda ko‘rinadi. Node agent har bir kompyuterda ishlaydi va ERP’ga internet orqali yuboradi.
			</div>
		</div>
	`);

	page.main.append($body);
	setText($body.find(".rfidenter-url"), origin);
	setText($body.find(".rfidenter-endpoint"), ingestEndpoint);

	const $status = $body.find(".rfidenter-gen-status");
	const $auth = $body.find(".rfidenter-auth-line");
	const $env = $body.find(".rfidenter-env");

	function renderToken(data) {
		const auth = String(data?.authorization || "").trim();
		setCode($auth, auth || "(yo‘q)");

		const snippet = auth
			? [
					`export ERP_PUSH_URL="${origin}"`,
					`export ERP_PUSH_AUTH="${auth}"`,
					`# ixtiyoriy: qurilma nomi`,
					`export ERP_PUSH_DEVICE="my-reader-pc"`,
					`# keyin Node’ni ishga tushiring (start-web.sh)`,
			  ].join("\n")
			: "";
		setCode($env, snippet || "(Token yaratilgandan keyin shu yerda chiqadi)");
	}

	$body.find(".rfidenter-generate").on("click", async () => {
		try {
			$status.text("Yaratilmoqda...");
			const r = await frappe.call("rfidenter.rfidenter.api.generate_user_token");
			if (!r || !r.message || r.message.ok !== true) throw new Error("Token yaratilmadi");
			renderToken(r.message);
			$status.text("Tayyor");
		} catch (e) {
			$status.text("");
			frappe.msgprint({
				title: "Xatolik",
				message: escapeHtml(e?.message || e),
				indicator: "red",
			});
		}
	});

	renderToken(null);
};

