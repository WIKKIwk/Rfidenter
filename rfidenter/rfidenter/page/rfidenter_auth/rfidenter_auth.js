/* global frappe */

frappe.pages["rfidenter-auth"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "RFIDenter — Authentication",
		single_column: true,
	});

	const $body = $(`
		<div class="rfidenter-auth">
			<div class="panel panel-default">
				<div class="panel-heading"><b>Token</b></div>
				<div class="panel-body">
					<div class="text-muted">Token olish endi <b>RFIDenter Settings</b> sahifasida.</div>
					<div style="margin-top: 10px">
						<a class="btn btn-primary btn-sm" href="/app/rfidenter-settings">Settingsga o‘tish</a>
					</div>
				</div>
			</div>
		</div>
	`);

	page.main.append($body);

	window.setTimeout(() => {
		try {
			frappe.set_route("rfidenter-settings");
		} catch {
			// ignore
		}
	}, 200);
};
