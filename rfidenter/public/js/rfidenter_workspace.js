(function () {
	"use strict";

	const WORKSPACE_TITLE = "RFIDenter";
	const ROOT_CLASS = "rfidenter-workspace";
	const LEAVING_CLASS = "rfidenter-workspace-leaving";

	const isRfidWorkspace = () => {
		if (!window.frappe || !frappe.get_route) {
			return false;
		}
		const route = frappe.get_route();
		return Array.isArray(route) && route[0] === "Workspaces" && route[1] === WORKSPACE_TITLE;
	};

	const updateBodyClass = () => {
		const isWorkspace = isRfidWorkspace();
		document.body.classList.toggle(ROOT_CLASS, isWorkspace);
		if (!isWorkspace) {
			document.body.classList.remove(LEAVING_CLASS);
		}
	};

	const handlePress = (event) => {
		if (!document.body.classList.contains(ROOT_CLASS)) {
			return;
		}
		const target = event.target.closest(".shortcut-widget-box");
		if (!target) {
			return;
		}
		document.body.classList.add(LEAVING_CLASS);
		window.clearTimeout(handlePress._timer);
		handlePress._timer = window.setTimeout(() => {
			document.body.classList.remove(LEAVING_CLASS);
		}, 220);
	};

	const bindOnce = () => {
		if (window.__rfidenterWorkspaceBound) {
			return;
		}
		window.__rfidenterWorkspaceBound = true;
		document.addEventListener("pointerdown", handlePress, true);
	};

	const init = () => {
		updateBodyClass();
		bindOnce();
		if (window.frappe && frappe.router && frappe.router.on) {
			frappe.router.on("change", updateBodyClass);
		}
	};

	if (window.frappe && frappe.ready) {
		frappe.ready(init);
	} else {
		document.addEventListener("DOMContentLoaded", init);
	}
})();
