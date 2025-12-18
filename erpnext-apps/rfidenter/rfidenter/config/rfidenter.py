from frappe import _


def get_data():
	return [
		{
			"label": _("RFIDenter"),
			"items": [
				{"type": "page", "name": "rfidenter-settings", "label": _("Sozlamalar")},
				{"type": "page", "name": "rfidenter-auth", "label": _("Autentifikatsiya (Token)")},
				{"type": "page", "name": "rfidenter-antenna", "label": _("O‘qish (Read)")},
			],
		}
	]
