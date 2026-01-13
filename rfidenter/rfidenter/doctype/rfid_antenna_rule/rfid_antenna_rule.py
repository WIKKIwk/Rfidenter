from __future__ import annotations

import frappe
from frappe.model.document import Document


class RFIDAntennaRule(Document):
	def validate(self) -> None:
		device_norm = str(self.device or "").strip()[:64]
		device_norm = device_norm.lower() if device_norm else "any"
		self.device = device_norm

		try:
			ant = int(self.antenna_id or 0)
		except Exception:
			ant = 0
		if ant <= 0:
			frappe.throw("Antenna port noto'g'ri.", frappe.ValidationError)

		existing_rows = frappe.db.sql(
			"""
			SELECT name
			FROM `tabRFID Antenna Rule`
			WHERE LOWER(device) = LOWER(%s) AND antenna_id = %s
			""",
			(device_norm, ant),
		)
		if existing_rows:
			existing = str(existing_rows[0][0] or "")
			if existing and existing != self.name:
				frappe.throw("Duplicate antenna rule rows.", frappe.ValidationError)
