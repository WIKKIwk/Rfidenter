from __future__ import annotations

import frappe


def _add_unique_index(table: str, index_name: str, columns: list[str]) -> None:
	cols = ", ".join([f"`{c}`" for c in columns])
	try:
		frappe.db.sql(f"ALTER TABLE `{table}` ADD UNIQUE INDEX `{index_name}` ({cols})")
	except Exception:
		# Index may already exist or table not ready.
		pass


def _add_index(table: str, index_name: str, columns: list[str]) -> None:
	cols = ", ".join([f"`{c}`" for c in columns])
	try:
		frappe.db.sql(f"ALTER TABLE `{table}` ADD INDEX `{index_name}` ({cols})")
	except Exception:
		pass


def execute() -> None:
	if frappe.db.table_exists("RFID Edge Event"):
		_add_unique_index("tabRFID Edge Event", "uniq_device_batch_seq", ["device_id", "batch_id", "seq"])

	if frappe.db.table_exists("RFID Agent Request"):
		_add_index("tabRFID Agent Request", "idx_agent_status_created", ["agent_id", "status", "creation"])
