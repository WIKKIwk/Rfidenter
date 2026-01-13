from __future__ import annotations

import hashlib
import json
import re
import secrets
from typing import Any

import frappe


STALE_CLAIM_SEC = 120


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


def _normalize_idempotency_key(raw: Any) -> str:
	s = str(raw or "").strip()
	if not s:
		return ""
	return s[:120]


def _make_dedupe_key(raw_key: str, kind: str) -> str:
	key = _normalize_idempotency_key(raw_key)
	if not key:
		return ""
	kind_norm = str(kind or "").strip() or "unknown"
	return f"{kind_norm}:{key}"[:180]


def _payload_hash(payload: dict[str, Any]) -> str:
	try:
		raw = json.dumps(payload, separators=(",", ":"), sort_keys=True)
	except Exception:
		return ""
	try:
		return hashlib.sha256(raw.encode("utf-8")).hexdigest()
	except Exception:
		return ""


def _is_claim_stale(doc: frappe.model.document.Document) -> bool:
	claimed_at = getattr(doc, "claimed_at", None) or getattr(doc, "created_at", None)
	if not claimed_at:
		return True
	try:
		age = frappe.utils.now_datetime() - claimed_at
		return age.total_seconds() > STALE_CLAIM_SEC
	except Exception:
		return True


def _claim_dedupe(
	idempotency_key: str,
	*,
	kind: str,
	payload_hash: str,
	raw_key: str | None = None,
	key_type: str | None = None,
	epc: str | None = None,
) -> tuple[frappe.model.document.Document | None, bool]:
	dedupe_key = _make_dedupe_key(idempotency_key, kind)
	if not dedupe_key:
		return None, False

	now = frappe.utils.now_datetime()
	doc = frappe.get_doc(
		{
			"doctype": "RFID Zebra Dedupe",
			"idempotency_key": dedupe_key,
			"raw_key": _normalize_idempotency_key(raw_key or idempotency_key),
			"key_type": str(key_type or "").strip() or None,
			"kind": str(kind or "").strip() or None,
			"status": "CLAIMED",
			"payload_hash": payload_hash or "",
			"epc": str(epc or "")[:128],
			"claimed_at": now,
			"created_at": now,
		}
	)
	try:
		doc.insert(ignore_permissions=True)
		return doc, True
	except Exception as exc:
		if isinstance(exc, frappe.DuplicateEntryError) or "Duplicate entry" in str(exc):
			try:
				existing = frappe.get_doc("RFID Zebra Dedupe", dedupe_key)
				status = str(getattr(existing, "status", "") or "")
				doc_type = str(getattr(existing, "doc_type", "") or "")
				doc_name = str(getattr(existing, "doc_name", "") or "")
				if status == "DONE" and doc_type and doc_name:
					return existing, False
				if status == "CLAIMED" and _is_claim_stale(existing):
					existing.status = "CLAIMED"
					existing.claimed_at = now
					existing.last_error = ""
					existing.save(ignore_permissions=True)
					return existing, True
				return existing, False
			except Exception:
				return None, False
		raise


def _finish_dedupe(
	doc: frappe.model.document.Document | None, *, doc_type: str, doc_name: str | None, status: str, error: str | None
) -> None:
	if not doc:
		return
	doc.doc_type = doc_type
	doc.doc_name = doc_name or ""
	doc.status = status
	doc.last_error = str(error or "")[:500] if status == "FAILED" else ""
	doc.save(ignore_permissions=True)


def _get_site_setting(key: str, default: Any = None) -> Any:
	try:
		site_conf = frappe.get_site_config(silent=True) or {}
	except Exception:
		site_conf = {}
	return site_conf.get(key, frappe.conf.get(key, default))


def _consume_requires_ant_match() -> bool:
	"""Whether Zebra consume must match `consume_ant_id`.

	Default: False (any antenna read can consume).
	"""

	raw = _get_site_setting("rfidenter_zebra_consume_requires_ant_match", False)
	if isinstance(raw, bool):
		return raw
	s = str(raw or "").strip().lower()
	return s in ("1", "true", "yes", "y", "on")


def _processing_claim_ttl_sec() -> int:
	"""Seconds after which a stuck Processing tag can be reclaimed."""

	raw = _get_site_setting("rfidenter_zebra_processing_ttl_sec", 180)
	try:
		value = int(float(raw))
	except Exception:
		return 0
	if value <= 0:
		return 0
	return min(3600, value)


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


def _default_stock_entry_series() -> str:
	try:
		meta = frappe.get_meta("Stock Entry")
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
	row = (
		frappe.db.get_value(
			"RFID Zebra Tag",
			epc_norm,
			["status", "purchase_receipt", "item_code", "qty", "uom", "consume_ant_id", "client_request_id"],
			as_dict=True,
		)
		or {}
	)
	if not row:
		raise frappe.DoesNotExistError("RFID Zebra Tag topilmadi.")

	status = str(row.get("status") or "").strip()
	now = frappe.utils.now_datetime()

	update: dict[str, Any] = {"printed_at": now, "last_error": ""}
	if status not in ("Consumed", "Processing"):
		update["status"] = "Printed"
	frappe.db.set_value("RFID Zebra Tag", epc_norm, update, update_modified=True)

	se_name = str(row.get("purchase_receipt") or "").strip()
	se_created = False
	se_error = ""

	# If the tag is already being processed/consumed, don't create duplicates.
	if not se_name and status not in ("Consumed", "Processing"):
		ant_id = _normalize_ant(row.get("consume_ant_id"))

		prev_user = frappe.session.user
		try:
			frappe.set_user("Administrator")
		except Exception:
			prev_user = None

		try:
			client_request_id = str(row.get("client_request_id") or "").strip()
			idempotency_key = client_request_id if client_request_id else None
			key_type = "client_request_id" if client_request_id else None

			se_name = _create_stock_entry_draft_for_tag(
				{"epc": epc_norm, "item_code": row.get("item_code"), "qty": row.get("qty"), "uom": row.get("uom")},
				ant_id=ant_id,
				device="zebra-print",
				idempotency_key=idempotency_key,
				key_type=key_type,
			)
			frappe.db.set_value(
				"RFID Zebra Tag",
				epc_norm,
				{"purchase_receipt": se_name, "last_error": ""},
				update_modified=True,
			)
			se_created = True
		except Exception as exc:
			se_error = str(exc)
			frappe.db.set_value(
				"RFID Zebra Tag",
				epc_norm,
				{"status": "Error", "last_error": se_error[:500]},
				update_modified=True,
			)
		finally:
			if prev_user:
				try:
					frappe.set_user(prev_user)
				except Exception:
					pass

	return {
		"ok": True,
		"epc": epc_norm,
		"printed_at": now,
		"stock_entry": se_name,
		"stock_entry_created": se_created,
		"stock_entry_error": se_error,
	}


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
			"delivery_note",
			"delivery_note_submitted_at",
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
		modified_by = str(getattr(frappe.session, "user", None) or "Administrator")
		ttl = _processing_claim_ttl_sec()
		if ttl > 0:
			frappe.db.sql(
				"""
				UPDATE `tabRFID Zebra Tag`
				SET `status`='Processing', `last_error`='', `modified`=NOW(), `modified_by`=%s
				WHERE `name`=%s
				  AND (
						COALESCE(`status`, '') NOT IN ('Consumed', 'Processing')
						OR (`status`='Processing' AND TIMESTAMPDIFF(SECOND, `modified`, NOW()) >= %s)
					)
				""",
				(modified_by, epc, ttl),
			)
		else:
			frappe.db.sql(
				"""
				UPDATE `tabRFID Zebra Tag`
				SET `status`='Processing', `last_error`='', `modified`=NOW(), `modified_by`=%s
				WHERE `name`=%s
				  AND COALESCE(`status`, '') NOT IN ('Consumed', 'Processing')
				""",
				(modified_by, epc),
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


def _uom_conversion_factor(item_code: str, *, uom: str, stock_uom: str) -> float:
	uom = str(uom or "").strip()
	stock_uom = str(stock_uom or "").strip()
	if not uom or not stock_uom or uom == stock_uom:
		return 1.0

	cf = frappe.db.get_value(
		"UOM Conversion Detail",
		{"parent": item_code, "parenttype": "Item", "uom": uom},
		"conversion_factor",
	)
	try:
		v = float(cf)
	except Exception:
		v = 0.0
	if v <= 0:
		raise ValueError(f"Conversion factor topilmadi: {item_code} ({uom} → {stock_uom})")
	return min(1_000_000.0, v)


def _create_stock_entry_draft_for_tag(
	tag: dict[str, Any], *, ant_id: int, device: str, idempotency_key: str | None = None, key_type: str | None = None
) -> str:
	item_code = str(tag.get("item_code") or "").strip()
	qty = float(tag.get("qty") or 0)
	uom = str(tag.get("uom") or "").strip()
	if not item_code or qty <= 0 or not uom:
		raise ValueError("Tag meta noto‘g‘ri.")

	claim = None
	if idempotency_key:
		payload_hash = _payload_hash(
			{
				"item_code": item_code,
				"qty": qty,
				"uom": uom,
				"ant_id": ant_id,
				"device": str(device or "")[:64],
				"epc": str(tag.get("epc") or ""),
			}
		)
		claim, created = _claim_dedupe(
			idempotency_key,
			kind="stock_entry",
			payload_hash=payload_hash,
			raw_key=idempotency_key,
			key_type=key_type,
			epc=str(tag.get("epc") or ""),
		)
		if claim and not created:
			doc_name = str(getattr(claim, "doc_name", "") or "")
			doc_type = str(getattr(claim, "doc_type", "") or "")
			status = str(getattr(claim, "status", "") or "")
			if doc_type == "Stock Entry" and doc_name:
				return doc_name
			if status == "CLAIMED":
				raise frappe.ValidationError("Stock Entry dedupe claimed.")
			if status == "FAILED":
				raise frappe.ValidationError("Stock Entry dedupe failed.")

	settings_name = frappe.db.get_value("RFID Zebra Item Receipt Setting", {"item_code": item_code}, "name")
	if not settings_name:
		raise ValueError(f"Item receipt settings topilmadi: {item_code}")
	settings = frappe.get_doc("RFID Zebra Item Receipt Setting", settings_name)

	series = str(getattr(settings, "naming_series", "") or "").strip() or _default_stock_entry_series()

	item = frappe.db.get_value("Item", item_code, ["stock_uom"], as_dict=True)
	stock_uom = str((item or {}).get("stock_uom") or "").strip()
	if not stock_uom:
		raise ValueError("Item stock_uom aniqlanmadi.")

	uom_value = uom or stock_uom
	cf = _uom_conversion_factor(item_code, uom=uom_value, stock_uom=stock_uom)
	transfer_qty = qty * cf

	event_id = str(tag.get("event_id") or "").strip()
	batch_id = str(tag.get("batch_id") or "").strip()
	seq = tag.get("seq")
	remarks = f"RFID Zebra: EPC={tag.get('epc')} ANT={ant_id} DEV={device}"
	if event_id:
		remarks += f" EVENT={event_id}"
	if batch_id:
		remarks += f" BATCH={batch_id}"
	if seq is not None:
		remarks += f" SEQ={seq}"

	values = {
		"doctype": "Stock Entry",
		"stock_entry_type": "Material Issue",
		"company": settings.company,
		"posting_date": frappe.utils.nowdate(),
		"posting_time": frappe.utils.nowtime(),
		"set_posting_time": 1,
		"from_warehouse": settings.warehouse,
		"items": [
			{
				"item_code": item_code,
				"qty": qty,
				"uom": uom_value,
				"stock_uom": stock_uom,
				"conversion_factor": cf,
				"transfer_qty": transfer_qty,
				"s_warehouse": settings.warehouse,
				"allow_zero_valuation_rate": 1,
			}
			],
		"remarks": remarks,
	}
	if series:
		values["naming_series"] = series

	se_doc = frappe.get_doc(values)

	try:
		se_doc.insert(ignore_permissions=True)
		_finish_dedupe(claim, doc_type="Stock Entry", doc_name=se_doc.name, status="DONE", error=None)
		return se_doc.name
	except Exception as exc:
		_finish_dedupe(claim, doc_type="Stock Entry", doc_name=None, status="FAILED", error=str(exc))
		raise


def _create_delivery_note_draft_for_tag(
	tag: dict[str, Any], *, ant_id: int, device: str, idempotency_key: str | None = None, key_type: str | None = None
) -> str:
	item_code = str(tag.get("item_code") or "").strip()
	qty = float(tag.get("qty") or 0)
	uom = str(tag.get("uom") or "").strip()
	if not item_code or qty <= 0 or not uom:
		raise ValueError("Tag meta noto‘g‘ri.")

	claim = None
	if idempotency_key:
		payload_hash = _payload_hash(
			{
				"item_code": item_code,
				"qty": qty,
				"uom": uom,
				"ant_id": ant_id,
				"device": str(device or "")[:64],
				"epc": str(tag.get("epc") or ""),
			}
		)
		claim, created = _claim_dedupe(
			idempotency_key,
			kind="delivery_note",
			payload_hash=payload_hash,
			raw_key=idempotency_key,
			key_type=key_type,
			epc=str(tag.get("epc") or ""),
		)
		if claim and not created:
			doc_name = str(getattr(claim, "doc_name", "") or "")
			doc_type = str(getattr(claim, "doc_type", "") or "")
			status = str(getattr(claim, "status", "") or "")
			if doc_type == "Delivery Note" and doc_name:
				return doc_name
			if status == "CLAIMED":
				raise frappe.ValidationError("Delivery Note dedupe claimed.")
			if status == "FAILED":
				raise frappe.ValidationError("Delivery Note dedupe failed.")

	settings_name = frappe.db.get_value("RFID Delivery Note Setting", {"item_code": item_code}, "name")
	if not settings_name:
		raise ValueError(f"Delivery note settings topilmadi: {item_code}")
	settings = frappe.get_doc("RFID Delivery Note Setting", settings_name)

	item = frappe.db.get_value("Item", item_code, ["stock_uom"], as_dict=True)
	stock_uom = str((item or {}).get("stock_uom") or "").strip()
	if not stock_uom:
		raise ValueError("Item stock_uom aniqlanmadi.")

	default_rate = 0.0
	try:
		default_rate = float(settings.default_rate or 0)
	except Exception:
		default_rate = 0.0
	if default_rate < 0:
		default_rate = 0.0

	uom_value = uom or stock_uom
	cf = _uom_conversion_factor(item_code, uom=uom_value, stock_uom=stock_uom)

	event_id = str(tag.get("event_id") or "").strip()
	batch_id = str(tag.get("batch_id") or "").strip()
	seq = tag.get("seq")
	remarks = f"RFID Zebra: EPC={tag.get('epc')} ANT={ant_id} DEV={device}"
	if event_id:
		remarks += f" EVENT={event_id}"
	if batch_id:
		remarks += f" BATCH={batch_id}"
	if seq is not None:
		remarks += f" SEQ={seq}"

	values = {
		"doctype": "Delivery Note",
		"company": settings.company,
		"customer": settings.customer,
		"posting_date": frappe.utils.nowdate(),
		"posting_time": frappe.utils.nowtime(),
		"set_posting_time": 1,
		"items": [
			{
				"item_code": item_code,
				"qty": qty,
				"uom": uom_value,
				"stock_uom": stock_uom,
				"conversion_factor": cf,
				"warehouse": settings.warehouse,
				"rate": default_rate,
				"price_list_rate": default_rate,
			}
			],
		"remarks": remarks,
	}
	if getattr(settings, "selling_price_list", None):
		values["selling_price_list"] = settings.selling_price_list

	dn_doc = frappe.get_doc(values)
	try:
		dn_doc.set_missing_values()
	except Exception:
		pass
	try:
		dn_doc.insert(ignore_permissions=True)
		_finish_dedupe(claim, doc_type="Delivery Note", doc_name=dn_doc.name, status="DONE", error=None)
		return dn_doc.name
	except Exception as exc:
		_finish_dedupe(claim, doc_type="Delivery Note", doc_name=None, status="FAILED", error=str(exc))
		raise


def _submit_delivery_note(dn_name: str, *, ant_id: int, device: str) -> None:
	name = str(dn_name or "").strip()
	if not name:
		raise ValueError("Delivery Note yo‘q.")
	if not frappe.db.exists("Delivery Note", name):
		raise frappe.DoesNotExistError(f"Delivery Note topilmadi: {name}")

	dn_doc = frappe.get_doc("Delivery Note", name)
	if int(getattr(dn_doc, "docstatus", 0)) == 2:
		raise frappe.ValidationError(f"Delivery Note bekor qilingan: {name}")

	if int(getattr(dn_doc, "docstatus", 0)) == 0:
		try:
			dn_doc.set("posting_date", frappe.utils.nowdate())
			dn_doc.set("posting_time", frappe.utils.nowtime())
			dn_doc.set("set_posting_time", 1)
		except Exception:
			pass

		try:
			remarks = str(getattr(dn_doc, "remarks", "") or "")
			append = f"RFID Zebra delivery: ANT={ant_id} DEV={device}"
			if append not in remarks:
				dn_doc.set("remarks", (remarks + ("\n" if remarks else "") + append)[:1000])
		except Exception:
			pass

		dn_doc.submit()


def _submit_stock_entry(se_name: str, *, ant_id: int, device: str) -> None:
	name = str(se_name or "").strip()
	if not name:
		raise ValueError("Stock Entry yo‘q.")
	if not frappe.db.exists("Stock Entry", name):
		raise frappe.DoesNotExistError(f"Stock Entry topilmadi: {name}")

	se_doc = frappe.get_doc("Stock Entry", name)
	if int(getattr(se_doc, "docstatus", 0)) == 2:
		raise frappe.ValidationError(f"Stock Entry bekor qilingan: {name}")

	if int(getattr(se_doc, "docstatus", 0)) == 0:
		# Ensure posting time reflects the actual consume event.
		try:
			se_doc.set("posting_date", frappe.utils.nowdate())
			se_doc.set("posting_time", frappe.utils.nowtime())
			se_doc.set("set_posting_time", 1)
		except Exception:
			# best-effort
			pass

		try:
			remarks = str(getattr(se_doc, "remarks", "") or "")
			append = f"RFID Zebra consume: ANT={ant_id} DEV={device}"
			if append not in remarks:
				se_doc.set("remarks", (remarks + ("\n" if remarks else "") + append)[:1000])
		except Exception:
			# best-effort
			pass

		se_doc.submit()


def _normalize_device_key(raw: str) -> str:
	s = str(raw or "").strip().lower()
	if not s:
		return "any"
	return s[:64]


def _load_antenna_rules() -> dict[str, dict[int, dict[str, Any]]]:
	rows = frappe.get_all(
		"RFID Antenna Rule",
		fields=["device", "antenna_id", "submit_stock_entry", "create_delivery_note", "submit_delivery_note"],
	)
	rules: dict[str, dict[int, dict[str, Any]]] = {}
	for row in rows:
		device = _normalize_device_key(row.get("device") or "any")
		ant_id = _normalize_ant(row.get("antenna_id") or 0)
		if ant_id <= 0:
			continue
		entry = {
			"device": device,
			"antenna_id": ant_id,
			"submit_stock_entry": bool(row.get("submit_stock_entry")),
			"create_delivery_note": bool(row.get("create_delivery_note")),
			"submit_delivery_note": bool(row.get("submit_delivery_note")),
		}
		rules.setdefault(device, {})[ant_id] = entry
	return rules


def _find_rule_for_ants(
	ants: set[int], rules: dict[str, dict[int, dict[str, Any]]], device_key: str, field: str
) -> tuple[int, dict[str, Any] | None]:
	for ant_id in sorted(ants):
		rule = rules.get(device_key, {}).get(ant_id) or rules.get("any", {}).get(ant_id)
		if rule and bool(rule.get(field)):
			return ant_id, rule
	return 0, None


def process_tag_reads(
	tags: list[dict[str, Any]],
	*,
	device: str = "",
	event_id: str | None = None,
	batch_id: str | None = None,
	seq: int | None = None,
) -> dict[str, Any]:
	"""Process UHF reads: submit Stock Entry for known Zebra EPCs."""

	if not tags:
		return {"ok": True, "processed": 0}
	if not event_id:
		return {"ok": True, "processed": 0}

	require_ant_match = _consume_requires_ant_match()
	rules = _load_antenna_rules()
	device_key = _normalize_device_key(device)
	event_fields = {
		"last_event_id": event_id,
		"last_batch_id": batch_id,
		"last_seq": seq,
		"last_device_id": str(device or "")[:64],
	}
	device_rules = rules.get(device_key, {})
	any_rules = rules.get("any", {})
	has_stock_rules = any(bool(r.get("submit_stock_entry")) for r in device_rules.values()) or any(
		bool(r.get("submit_stock_entry")) for r in any_rules.values()
	)

	# Extract unique EPCs and the set of antennas that saw them in this batch.
	by_epc: dict[str, set[int]] = {}
	for t in tags:
		if not isinstance(t, dict):
			continue
		epc = _normalize_hex(t.get("epcId") or t.get("EPC") or "")
		if not epc:
			continue
		ant = _normalize_ant(t.get("antId") or t.get("ANT") or 0)
		if ant > 0:
			by_epc.setdefault(epc, set()).add(ant)
		else:
			by_epc.setdefault(epc, set())

	epcs = list(by_epc.keys())[:200]
	if not epcs:
		return {"ok": True, "processed": 0}

	# Fetch matching tags that are not yet consumed.
	rows = frappe.get_all(
		"RFID Zebra Tag",
		fields=[
			"name",
			"epc",
			"item_code",
			"qty",
			"uom",
			"consume_ant_id",
			"status",
			"printed_at",
			"scan_recon_required",
			"purchase_receipt",
			"delivery_note",
			"client_request_id",
		],
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

			ants = by_epc.get(epc)
			if not isinstance(ants, set):
				ants = set()

			expected = _normalize_ant(row.get("consume_ant_id"))
			status = str(row.get("status") or "").strip()
			printed_at = row.get("printed_at")
			scan_recon_required = int(row.get("scan_recon_required") or 0)
			if status != "Printed" or not printed_at or scan_recon_required:
				continue

			ant_for_stock, rule_stock = _find_rule_for_ants(ants, rules, device_key, "submit_stock_entry")
			ant_for_delivery, rule_delivery = _find_rule_for_ants(ants, rules, device_key, "submit_delivery_note")

			stock_ant = 0
			if ant_for_stock:
				stock_ant = ant_for_stock
			elif has_stock_rules:
				stock_ant = 0
			elif expected > 0 and expected in ants:
				stock_ant = expected
			elif require_ant_match and expected > 0 and ants:
				# This tag was seen on some other antenna, and strict match is enabled.
				stock_ant = 0
			else:
				stock_ant = min(ants) if ants else 0

			stock_entry_submitted = False
			se_name = str(row.get("purchase_receipt") or "").strip()
			client_request_id = str(row.get("client_request_id") or "").strip()
			idempotency_key = client_request_id if client_request_id else None
			key_type = "client_request_id" if client_request_id else None
			if not idempotency_key and event_id:
				idempotency_key = f"{event_id}:{epc}"
				key_type = "event_id"

			if stock_ant:
				try:
					# If Stock Entry already exists and is submitted, skip submit but allow DN creation.
					if se_name:
						se_docstatus = frappe.db.get_value("Stock Entry", se_name, "docstatus") or 0
						if int(se_docstatus) == 1:
							stock_entry_submitted = True
						elif int(se_docstatus) == 0:
							if _claim_for_processing(epc):
								_submit_stock_entry(se_name, ant_id=stock_ant, device=str(device or "")[:64])
								stock_entry_submitted = True
					else:
						# Claim first to avoid double receipts.
						if _claim_for_processing(epc):
							tag_payload = {
								"epc": epc,
								"item_code": row.get("item_code"),
								"qty": row.get("qty"),
								"uom": row.get("uom"),
								"event_id": event_id,
								"batch_id": batch_id,
								"seq": seq,
							}
							se_name = _create_stock_entry_draft_for_tag(
								tag_payload,
								ant_id=stock_ant,
								device=str(device or "")[:64],
								idempotency_key=idempotency_key,
								key_type=key_type,
							)
							# Persist draft name even if submit fails, to prevent duplicates on retries.
							frappe.db.set_value(
								"RFID Zebra Tag",
								epc,
								{"purchase_receipt": se_name, **event_fields},
								update_modified=True,
							)
							_submit_stock_entry(se_name, ant_id=stock_ant, device=str(device or "")[:64])
							stock_entry_submitted = True

					if stock_entry_submitted:
						frappe.db.set_value(
							"RFID Zebra Tag",
							epc,
							{
								"status": "Consumed",
								"purchase_receipt": se_name,
								"consumed_at": frappe.utils.now_datetime(),
								"consumed_device": str(device or "")[:64],
								"last_error": "",
								**event_fields,
							},
							update_modified=True,
						)
						processed += 1
				except Exception as exc:
					_set_error(epc, str(exc))

			try:
				delivery_note = str(row.get("delivery_note") or "").strip()
				create_dn = bool(rule_stock and rule_stock.get("create_delivery_note"))
				if stock_entry_submitted and create_dn and not delivery_note:
					tag_payload = {
						"epc": epc,
						"item_code": row.get("item_code"),
						"qty": row.get("qty"),
						"uom": row.get("uom"),
						"event_id": event_id,
						"batch_id": batch_id,
						"seq": seq,
					}
					delivery_note = _create_delivery_note_draft_for_tag(
						tag_payload,
						ant_id=stock_ant or ant_for_stock or 0,
						device=str(device or "")[:64],
						idempotency_key=idempotency_key,
						key_type=key_type,
					)
					frappe.db.set_value(
						"RFID Zebra Tag",
						epc,
						{"delivery_note": delivery_note, "last_error": "", **event_fields},
						update_modified=True,
					)

				if ant_for_delivery and delivery_note:
					dn_docstatus = frappe.db.get_value("Delivery Note", delivery_note, "docstatus") or 0
					if int(dn_docstatus) == 0:
						_submit_delivery_note(delivery_note, ant_id=ant_for_delivery, device=str(device or "")[:64])
						frappe.db.set_value(
							"RFID Zebra Tag",
							epc,
							{
								"delivery_note_submitted_at": frappe.utils.now_datetime(),
								"delivery_note_device": str(device or "")[:64],
								"last_error": "",
								**event_fields,
							},
							update_modified=True,
						)
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
