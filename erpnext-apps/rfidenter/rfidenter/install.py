from __future__ import annotations

import frappe


RFIDENTER_ROLE = "RFIDer"


def _ensure_role() -> None:
	if frappe.db.exists("Role", RFIDENTER_ROLE):
		return

	role = frappe.new_doc("Role")
	role.role_name = RFIDENTER_ROLE
	role.home_page = "/app/rfidenter"
	role.insert(ignore_permissions=True)


def before_migrate() -> None:
	# Ensure the role exists before workspace/page sync tries to reference it.
	_ensure_role()


def after_install() -> None:
	_ensure_role()

