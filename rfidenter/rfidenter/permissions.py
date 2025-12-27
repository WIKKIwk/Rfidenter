from __future__ import annotations

import frappe


RFIDENTER_ROLE = "RFIDer"


def has_rfidenter_access(user: str | None = None) -> bool:
	user = user or frappe.session.user
	if not user or user == "Guest":
		return False

	roles = frappe.get_roles(user)
	return (RFIDENTER_ROLE in roles) or ("System Manager" in roles)


def has_app_permission() -> bool:
	"""Hook: used by `add_to_apps_screen` to decide if RFIDenter shows in /apps."""
	return has_rfidenter_access()

