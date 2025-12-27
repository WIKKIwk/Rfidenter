from __future__ import annotations

from frappe import _


def get_data():
	return [
		{
			"module_name": "RFIDenter",
			"category": "Modules",
			"label": _("RFIDenter"),
			"color": "#111111",
			"icon": "scan",
			"type": "module",
			"description": _("RFID reader realtime integration"),
		}
	]
