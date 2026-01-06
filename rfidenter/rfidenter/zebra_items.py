from __future__ import annotations

import re
import secrets
from typing import Any

import frappe


def _normalize_hex(raw: Any) -> str:
	value = str(raw or "").strip().upper()
	if not value:
		return ""
	value = re.sub(r"[^0-9A-F]+", "", value)
	return value


def _normalize_ant(raw: Any) -> int:
	try:
		v = int(raw)
	except Exception:
		return 0
	return v if 0 <= v <= 31 else 0


def _normalize_qty(raw: Any) -> float:
	try:
		v = float(raw)
	except Exception:
		return 0.0
	if v <= 0:
		return 0.0
	return min(1_000_000.0, v)


def _get_site_setting(key: str, default: Any = None) -> Any:
	try:
		site_conf = frappe.get_site_config(silent=True) or {}
	except Exception:
		site_conf = {}
	return site_conf.get(key, frappe.conf.get(key, default))


def _get_epc_prefix() -> str:
	"""Return an optional EPC hex prefix for Zebra-generated tags.

	This exists to reduce the chance of conflicts with other tags in the environment.
	"""

	prefix = _normalize_hex(_get_site_setting("rfidenter_zebra_epc_prefix", "5A42") or "")
	if not prefix:
		return ""
	# Ensure even length and cap so total length stays within 24 hex chars (96-bit EPC).
	if len(prefix) % 2 == 1:
		prefix = prefix[:-1]
	return prefix[:20]


def generate_epc_hex() -> str:
	"""Generate a random 96-bit EPC hex string (24 hex chars)."""

	prefix = _get_epc_prefix()
	remaining = 24 - len(prefix)
	remaining = max(0, min(24, remaining))
	if remaining % 2 == 1:
		remaining -= 1
	return (prefix + secrets.token_hex(remaining // 2).upper())[:24]


def _default_purchase_receipt_series() -> str:
	try:
		meta = frappe.get_meta("Purchase Receipt")
		field = meta.get_field("naming_series")
		options = str(getattr(field, "options", "") or "").splitlines()
		options = [o.strip() for o in options if o.strip()]
		return options[0] if options else ""
	except Exception:
		return ""


def create_item_tag(
	*,
	item_code: str,
	qty: Any,
	uom: str | None,
	consume_ant_id: Any,
	client_request_id: str | None,
	requested_by: str | None,
) -> dict[str, Any]:
	item_code = str(item_code or "").strip()
	if not item_code:
		raise frappe.ValidationError("Item tanlanmagan.")

	qty_value = _normalize_qty(qty)
	if qty_value <= 0:
		raise frappe.ValidationError("Qty noto‘g‘ri.")

	ant = _normalize_ant(consume_ant_id)

	client_request_id = str(client_request_id or "").strip()[:80] or None
	if client_request_id:
		existing = frappe.db.get_value("RFID Zebra Tag", {"client_request_id": client_request_id}, "name")
		if existing:
			doc = frappe.get_doc("RFID Zebra Tag", existing)
			return {
				"ok": True,
				"epc": doc.name,
				"tag": {
					"epc": doc.name,
					"item_code": doc.item_code,
					"item_name": doc.item_name,
					"qty": doc.qty,
					"uom": doc.uom,
					"consume_ant_id": doc.consume_ant_id,
					"status": doc.status,
					"purchase_receipt": doc.purchase_receipt,
					"printed_at": doc.printed_at,
					"consumed_at": doc.consumed_at,
				},
			}

	item = frappe.db.get_value("Item", item_code, ["item_name", "stock_uom"], as_dict=True)
	if not item:
		raise frappe.ValidationError("Item topilmadi.")

	uom_value = str(uom or "").strip() or str(item.get("stock_uom") or "").strip()
	if not uom_value:
		raise frappe.ValidationError("UOM aniqlanmadi.")

	requested_by = str(requested_by or "").strip() or None

	last_error = ""
	for _ in range(12):
		epc = generate_epc_hex()
		if len(epc) < 8:
			continue
		try:
			doc = frappe.get_doc(
				{
					"doctype": "RFID Zebra Tag",
					"epc": epc,
					"item_code": item_code,
					"qty": qty_value,
					"uom": uom_value,
					"consume_ant_id": ant,
					"status": "Pending Print",
					"client_request_id": client_request_id,
					"requested_by": requested_by,
				}
			)
			doc.insert(ignore_permissions=True)
			return {
				"ok": True,
				"epc": doc.name,
				"tag": {
					"epc": doc.name,
					"item_code": doc.item_code,
					"item_name": doc.item_name,
					"qty": doc.qty,
					"uom": doc.uom,
					"consume_ant_id": doc.consume_ant_id,
					"status": doc.status,
				},
			}
		except Exception as exc:
			last_error = str(exc)
			# Likely uniqueness conflict; retry with a new EPC.
			continue

	raise frappe.ValidationError(f"EPC yaratib bo‘lmadi: {last_error or 'unknown error'}")


def mark_tag_printed(*, epc: str) -> dict[str, Any]:
	epc_norm = _normalize_hex(epc)[:128]
	if not epc_norm:
		raise frappe.ValidationError("EPC noto‘g‘ri.")
	if not frappe.db.exists("RFID Zebra Tag", epc_norm):
		raise frappe.DoesNotExistError("RFID Zebra Tag topilmadi.")

	now = frappe.utils.now_datetime()
	frappe.db.set_value(
		"RFID Zebra Tag",
		epc_norm,
		{
			"status": "Printed",
			"printed_at": now,
			"last_error": "",
		},
		update_modified=True,
	)
	return {"ok": True, "epc": epc_norm, "printed_at": now}


def list_recent_tags(*, limit: Any | None = None) -> dict[str, Any]:
	try:
		lim = int(limit) if limit is not None else 30
	except Exception:
		lim = 30
	lim = max(5, min(200, lim))

	rows = frappe.get_all(
		"RFID Zebra Tag",
		fields=[
			"epc",
			"item_code",
			"item_name",
			"qty",
			"uom",
			"consume_ant_id",
			"status",
			"printed_at",
			"consumed_at",
			"purchase_receipt",
			"last_error",
		],
		order_by="modified desc",
		limit=lim,
	)
	return {"ok": True, "count": len(rows), "items": rows}


def _claim_for_processing(epc: str) -> bool:
	"""Try to atomically claim the tag for processing.

	Returns True only for the first caller.
	"""

	try:
		frappe.db.sql(
			"""
			UPDATE `tabRFID Zebra Tag`
			SET `status`='Processing', `last_error`=''
			WHERE `name`=%s
			  AND COALESCE(`purchase_receipt`, '') = ''
			  AND COALESCE(`status`, '') NOT IN ('Consumed')
			""",
			(epc,),
		)
		try:
			return bool(getattr(frappe.db, "_cursor", None) and frappe.db._cursor.rowcount)
		except Exception:
			return False
	except Exception:
		return False


def _set_error(epc: str, message: str) -> None:
	frappe.db.set_value(
		"RFID Zebra Tag",
		epc,
		{"status": "Error", "last_error": str(message or "")[:500]},
		update_modified=True,
	)


def _create_purchase_receipt_for_tag(tag: dict[str, Any], *, ant_id: int, device: str) -> str:
	item_code = str(tag.get("item_code") or "").strip()
	qty = float(tag.get("qty") or 0)
	uom = str(tag.get("uom") or "").strip()
	if not item_code or qty <= 0 or not uom:
		raise ValueError("Tag meta noto‘g‘ri.")

	settings_name = frappe.db.get_value("RFID Zebra Item Receipt Setting", {"item_code": item_code}, "name")
	if not settings_name:
		raise ValueError(f"Item receipt settings topilmadi: {item_code}")
	settings = frappe.get_doc("RFID Zebra Item Receipt Setting", settings_name)

	series = str(getattr(settings, "naming_series", "") or "").strip() or _default_purchase_receipt_series()

	values = {
		"doctype": "Purchase Receipt",
		"supplier": settings.supplier,
		"company": settings.company,
		"posting_date": frappe.utils.nowdate(),
		"posting_time": frappe.utils.nowtime(),
		"set_posting_time": 1,
		"items": [
			{
				"item_code": item_code,
				"qty": qty,
				"uom": uom,
				"warehouse": settings.warehouse,
			}
		],
		"remarks": f"RFID Zebra: EPC={tag.get('epc')} ANT={ant_id} DEV={device}",
	}
	if series:
		values["naming_series"] = series

	pr_doc = frappe.get_doc(values)

	pr_doc.insert(ignore_permissions=True)
	if bool(getattr(settings, "submit_purchase_receipt", 0)):
		pr_doc.submit()
	return pr_doc.name


def process_tag_reads(tags: list[dict[str, Any]], *, device: str = "") -> dict[str, Any]:
	"""Process UHF reads: create Purchase Receipt for known Zebra EPCs."""

	if not tags:
		return {"ok": True, "processed": 0}

	# Extract unique EPCs with antenna id.
	by_epc: dict[str, int] = {}
	for t in tags:
		if not isinstance(t, dict):
			continue
		epc = _normalize_hex(t.get("epcId") or t.get("EPC") or "")
		if not epc:
			continue
		ant = _normalize_ant(t.get("antId") or t.get("ANT") or 0)
		by_epc.setdefault(epc, ant)

	epcs = list(by_epc.keys())[:200]
	if not epcs:
		return {"ok": True, "processed": 0}

	# Fetch matching tags that are not yet consumed.
	rows = frappe.get_all(
		"RFID Zebra Tag",
		fields=["name", "epc", "item_code", "qty", "uom", "consume_ant_id", "status", "purchase_receipt"],
		filters={"epc": ["in", epcs]},
		limit=len(epcs),
	)

	processed = 0
	prev_user = frappe.session.user
	try:
		# Use Administrator context to avoid permission issues during stock document creation.
		try:
			frappe.set_user("Administrator")
		except Exception:
			pass

		for row in rows:
			epc = str(row.get("epc") or row.get("name") or "").strip()
			if not epc:
				continue
			if row.get("purchase_receipt"):
				continue

			ant_id = int(by_epc.get(epc) or 0)
			expected = _normalize_ant(row.get("consume_ant_id"))
			if expected and ant_id and expected != ant_id:
				continue

			# Claim first to avoid double receipts.
			if not _claim_for_processing(epc):
				continue

			try:
				pr_name = _create_purchase_receipt_for_tag(
					{"epc": epc, "item_code": row.get("item_code"), "qty": row.get("qty"), "uom": row.get("uom")},
					ant_id=ant_id,
					device=str(device or "")[:64],
				)
				frappe.db.set_value(
					"RFID Zebra Tag",
					epc,
					{
						"status": "Consumed",
						"purchase_receipt": pr_name,
						"consumed_at": frappe.utils.now_datetime(),
						"consumed_device": str(device or "")[:64],
						"last_error": "",
					},
					update_modified=True,
				)
				processed += 1
			except Exception as exc:
				_set_error(epc, str(exc))
	except Exception:
		# Avoid breaking ingest endpoint.
		frappe.log_error(title="RFIDenter zebra tag processing failed", message=frappe.get_traceback())
	finally:
		try:
			frappe.set_user(prev_user)
		except Exception:
			pass

	return {"ok": True, "processed": processed}
