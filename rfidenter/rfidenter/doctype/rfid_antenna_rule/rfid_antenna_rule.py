from __future__ import annotations

import frappe
from frappe.model.document import Document


class RFIDAntennaRule(Document):
	def validate(self) -> None:
		device = str(self.device or "").strip().lower() or "any"
		self.device = device

		try:
			ant = int(self.antenna_id or 0)
		except Exception:
			ant = 0
		if ant <= 0:
			frappe.throw("Antenna port noto'g'ri.", frappe.ValidationError)

		existing = frappe.db.get_value(
			"RFID Antenna Rule",
			{"device": device, "antenna_id": ant},
			"name",
		)
		if existing and existing != self.name:
			frappe.throw("Duplicate antenna rule rows.", frappe.ValidationError)
