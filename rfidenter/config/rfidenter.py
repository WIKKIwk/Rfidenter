from frappe import _


def get_data():
	return [
		{
			"label": _("RFIDenter"),
			"items": [
				{"type": "page", "name": "rfidenter-settings", "label": _("Sozlamalar")},
				{"type": "page", "name": "rfidenter-auth", "label": _("Autentifikatsiya (Token)")},
				{"type": "page", "name": "rfidenter-antenna", "label": _("O‘qish (Read)")},
				{"type": "page", "name": "rfidenter-zebra", "label": _("Zebra (Print)")},
				{"type": "page", "name": "rfidenter-flow", "label": _("Antenna oqimi")},
				{"type": "doctype", "name": "RFID Zebra Item Receipt Setting", "label": _("Item receipt settings")},
				{"type": "doctype", "name": "RFID Zebra Tag", "label": _("Zebra tags")},
			],
		}
	]
