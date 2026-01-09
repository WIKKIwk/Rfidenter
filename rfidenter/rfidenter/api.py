from __future__ import annotations

import json
import re
import time
from typing import Any

import frappe

from rfidenter.rfidenter.permissions import has_rfidenter_access
from rfidenter.rfidenter import zebra_items
from frappe.utils.password import get_decrypted_password

AGENT_CACHE_HASH = "rfidenter_agents"
AGENT_QUEUE_PREFIX = "rfidenter_agent_queue:"
AGENT_REQ_PREFIX = "rfidenter_agent_req:"
AGENT_REPLY_PREFIX = "rfidenter_agent_reply:"
SEEN_PREFIX = "rfidenter_seen:"
SCALE_CACHE_PREFIX = "rfidenter_scale_weight:"
SCALE_LAST_KEY = "rfidenter_scale_last"


def _get_site_token() -> str:
	# Prefer per-site config, fallback to common config.
	try:
		site_conf = frappe.get_site_config(silent=True) or {}
	except Exception:
		site_conf = {}
	token = (site_conf.get("rfidenter_token") or frappe.conf.get("rfidenter_token") or "").strip()
	return token


def _get_request_token() -> str:
	for key in ("X-RFIDenter-Token", "X-RFIDENTER-TOKEN", "X-RFIDENTER-TOKEN"):
		v = frappe.get_request_header(key)
		if v:
			return str(v).strip()
	return ""


def _require_auth_for_ingest() -> None:
	"""
	Auth rules:
	- If user is authenticated (API key/session), allow.
	- If user is Guest:
	  - If `rfidenter_token` is configured => require matching `X-RFIDenter-Token` header.
	  - Else => allow only from loopback (127.0.0.1/::1).
	"""
	if frappe.session.user and frappe.session.user != "Guest":
		return

	token = _get_site_token()
	if token:
		req_token = _get_request_token()
		if req_token != token:
			frappe.throw("RFIDenter token noto‘g‘ri yoki yo‘q. Header: X-RFIDenter-Token", frappe.PermissionError)
		return

	ip = getattr(frappe.local, "request_ip", None) or ""
	ip = str(ip).strip()
	if ip.startswith("127.") or ip == "::1":
		return

	frappe.throw(
		"Guest kirish taqiqlangan. `rfidenter_token` ni site_config.json ga qo‘ying yoki API key bilan kiring.",
		frappe.PermissionError,
	)


def _now_ms() -> int:
	return int(time.time() * 1000)


def _agent_ttl_sec() -> int:
	try:
		site_conf = frappe.get_site_config(silent=True) or {}
	except Exception:
		site_conf = {}

	raw = site_conf.get("rfidenter_agent_ttl_sec") or frappe.conf.get("rfidenter_agent_ttl_sec") or 60
	try:
		ttl = int(raw)
	except Exception:
		ttl = 60
	return max(10, min(3600, ttl))


def _dedup_by_ant_enabled() -> bool:
	try:
		site_conf = frappe.get_site_config(silent=True) or {}
	except Exception:
		site_conf = {}

	raw = site_conf.get("rfidenter_dedup_by_ant")
	if raw is None:
		raw = frappe.conf.get("rfidenter_dedup_by_ant")
	if raw is None:
		return True
	if isinstance(raw, bool):
		return raw
	s = str(raw).strip().lower()
	return s in ("1", "true", "yes", "y", "on")


def _dedup_ttl_sec() -> int:
	try:
		site_conf = frappe.get_site_config(silent=True) or {}
	except Exception:
		site_conf = {}

	raw = site_conf.get("rfidenter_dedup_ttl_sec") or frappe.conf.get("rfidenter_dedup_ttl_sec") or 86400
	try:
		ttl = int(raw)
	except Exception:
		ttl = 86400
	return max(60, min(30 * 86400, ttl))


def _normalize_hex(raw: Any) -> str:
	s = str(raw or "").strip().upper()
	if not s:
		return ""
	s = re.sub(r"[^0-9A-F]+", "", s)
	return s[:128]


def _normalize_ant(raw: Any) -> int:
	try:
		v = int(raw)
	except Exception:
		return 0
	return v if 0 <= v <= 31 else 0


def _normalize_count(raw: Any) -> int:
	try:
		v = int(raw)
	except Exception:
		return 1
	if v < 1:
		return 1
	return min(1_000_000, v)

def _normalize_note(raw: Any) -> str:
	s = str(raw or "").strip()
	if not s:
		return ""
	return s[:500]


def _sanitize_agent_id(raw: str) -> str:
	s = str(raw or "").strip()
	if not s:
		return ""
	s = s.lower()
	s = re.sub(r"[^a-z0-9._-]+", "-", s)
	s = re.sub(r"-{2,}", "-", s).strip("-")
	return s[:64]

def _normalize_weight(raw: Any) -> float | None:
	if raw is None or raw == "":
		return None
	try:
		val = float(raw)
	except Exception:
		return None
	if not (-1_000_000 <= val <= 1_000_000):
		return None
	return val


def _normalize_unit(raw: Any) -> str:
	s = str(raw or "").strip().lower()
	if not s:
		return ""
	mapper = {
		"kg": "kg",
		"kgs": "kg",
		"kilogram": "kg",
		"kilograms": "kg",
		"g": "g",
		"gram": "g",
		"grams": "g",
		"lb": "lb",
		"lbs": "lb",
		"pound": "lb",
		"pounds": "lb",
		"oz": "oz",
		"ounce": "oz",
		"ounces": "oz",
	}
	return mapper.get(s, s[:8])


def _normalize_bool(raw: Any) -> bool | None:
	if raw is None or raw == "":
		return None
	if isinstance(raw, bool):
		return raw
	s = str(raw).strip().lower()
	if s in ("1", "true", "yes", "y", "on", "stable", "st"):
		return True
	if s in ("0", "false", "no", "n", "off", "unstable", "us"):
		return False
	return None


def _scale_cache_ttl_sec() -> int:
	try:
		site_conf = frappe.get_site_config(silent=True) or {}
	except Exception:
		site_conf = {}

	raw = site_conf.get("rfidenter_scale_ttl_sec") or frappe.conf.get("rfidenter_scale_ttl_sec") or 300
	try:
		ttl = int(raw)
	except Exception:
		ttl = 300
	return max(5, min(3600, ttl))


def _rpc_timeout_sec(raw: Any | None = None) -> int:
	try:
		site_conf = frappe.get_site_config(silent=True) or {}
	except Exception:
		site_conf = {}

	fallback = site_conf.get("rfidenter_rpc_timeout_sec") or frappe.conf.get("rfidenter_rpc_timeout_sec") or 30

	value = raw if raw is not None else fallback
	try:
		timeout = int(value)
	except Exception:
		timeout = int(fallback) if str(fallback).strip().isdigit() else 30
	return max(2, min(120, timeout))


def _rpc_store_ttl_sec(timeout_sec: int) -> int:
	# Keep request+reply around a bit longer than the max wait
	return max(10, min(600, int(timeout_sec) + 90))


@frappe.whitelist(allow_guest=True)
def ping() -> dict[str, Any]:
	"""Simple health check for Node bridge."""
	return {"ok": True, "site": frappe.local.site}


@frappe.whitelist(allow_guest=True)
def ingest_tags(**kwargs) -> dict[str, Any]:
	"""
	Ingest tag events from the local RFID service (Node).

	Expected JSON body (recommended):
	{
	  "device": "archlinux",
	  "tags": [{ "epcId": "...", "rssi": 68, "antId": 1, ... }],
	  "ts": 1730000000000
	}

	Also supports form-encoded fields (tags can be a JSON string).
	"""
	_require_auth_for_ingest()
	if frappe.session.user and frappe.session.user != "Guest" and not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	body = {}
	try:
		body = frappe.request.get_json(silent=True) or {}
	except Exception:
		body = {}

	if not body:
		# Fallback to form_dict / kwargs
		try:
			body = dict(frappe.local.form_dict or {})
		except Exception:
			body = {}
		body.update(kwargs or {})

	device = str(body.get("device") or body.get("devName") or "unknown").strip() or "unknown"
	ts = body.get("ts")

	tags = body.get("tags") or []
	if isinstance(tags, str):
		try:
			tags = json.loads(tags)
		except Exception:
			tags = []

	if not isinstance(tags, list):
		tags = []

	# Safety limits
	tags = tags[:500]

	dedup_enabled = _dedup_by_ant_enabled()
	dedup_ttl = _dedup_ttl_sec()
	dedup_device = _sanitize_agent_id(device) or device

	# Aggregate within this request: same EPC+ANT -> single row with `count`.
	# This keeps ERP UI counts close to the local UI while reducing realtime payload size.
	agg: dict[str, dict[str, Any]] = {}
	seen_before = 0

	cache = frappe.cache() if dedup_enabled else None

	for tag in tags:
		if not isinstance(tag, dict):
			continue

		epc = _normalize_hex(tag.get("epcId") or tag.get("EPC") or "")
		if not epc:
			continue
		ant = _normalize_ant(tag.get("antId") or tag.get("ANT") or 0)
		cnt = _normalize_count(tag.get("count") or tag.get("reads") or tag.get("readCount") or 1)

		if dedup_enabled and cache and ant > 0:
			key = f"{SEEN_PREFIX}{dedup_device}:{ant}:{epc}"
			if cache.get_value(key, expires=True):
				seen_before += cnt
			else:
				cache.set_value(key, 1, expires_in_sec=dedup_ttl)

		agg_key = f"{epc}:{ant}"
		prev = agg.get(agg_key)
		if not prev:
			agg[agg_key] = {
				"epcId": epc,
				"memId": _normalize_hex(tag.get("memId") or tag.get("TID") or ""),
				"rssi": tag.get("rssi"),
				"antId": ant,
				"phaseBegin": tag.get("phaseBegin"),
				"phaseEnd": tag.get("phaseEnd"),
				"freqKhz": tag.get("freqKhz"),
				"devName": tag.get("devName") or device,
				"count": cnt,
			}
			continue

		prev["count"] = int(prev.get("count") or 0) + cnt
		for field in ("memId", "rssi", "phaseBegin", "phaseEnd", "freqKhz", "devName"):
			if tag.get(field) is not None:
				prev[field] = tag.get(field)

	agg_tags = list(agg.values())

	saved_count = 0
	saved_updated = False
	try:
		saved_count = _upsert_saved_tags(agg_tags, device)
		saved_updated = True
	except Exception:
		saved_updated = False
		frappe.log_error(title="RFIDenter saved tags update failed", message=frappe.get_traceback())

	payload = {"device": device, "ts": ts, "tags": agg_tags}
	# Broadcast to all logged-in desk users.
	published = True
	try:
		frappe.publish_realtime("rfidenter_tag_batch", payload, after_commit=False)
	except Exception:
		published = False
		frappe.log_error(title="RFIDenter publish_realtime failed", message=frappe.get_traceback())

	# Zebra item-tags: auto-submit Stock Entry (best-effort).
	zebra_processed = 0
	try:
		zebra_result = zebra_items.process_tag_reads(agg_tags, device=device)
		zebra_processed = int(zebra_result.get("processed") or 0) if isinstance(zebra_result, dict) else 0
	except Exception:
		zebra_processed = 0

	return {
		"ok": True,
		"received": len(tags),
		"unique": len(agg_tags),
		"aggregated": len(agg_tags),
		"seen_before": seen_before,
		"skipped": 0,
		"dedup_by_ant": dedup_enabled,
		"dedup_ttl_sec": dedup_ttl,
		"published": published,
		"saved_updated": saved_updated,
		"saved_count": saved_count,
		"zebra_processed": zebra_processed,
	}

@frappe.whitelist(allow_guest=True)
def ingest_scale_weight(**kwargs) -> dict[str, Any]:
	"""
	Ingest realtime scale (tarozi) readings from Zebra bridge.

	Expected JSON body:
	{
	  "device": "zebra-pc",
	  "weight": 1.234,
	  "unit": "kg",
	  "stable": true,
	  "port": "/dev/ttyUSB0",
	  "ts": 1730000000000
	}
	"""
	_require_auth_for_ingest()
	if frappe.session.user and frappe.session.user != "Guest" and not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	body = {}
	try:
		body = frappe.request.get_json(silent=True) or {}
	except Exception:
		body = {}

	if not body:
		try:
			body = dict(frappe.local.form_dict or {})
		except Exception:
			body = {}
		body.update(kwargs or {})

	device = str(body.get("device") or body.get("devName") or "scale").strip() or "scale"
	device_key = _sanitize_agent_id(device) or "scale"

	weight = _normalize_weight(body.get("weight") or body.get("value") or body.get("kg") or body.get("qty"))
	if weight is None:
		frappe.throw("Scale weight noto‘g‘ri yoki yo‘q.", frappe.ValidationError)

	unit = _normalize_unit(body.get("unit") or body.get("uom")) or "kg"
	stable = _normalize_bool(body.get("stable") or body.get("is_stable"))
	port = str(body.get("port") or "").strip()

	ts_raw = body.get("ts")
	ts = _now_ms()
	try:
		if ts_raw is not None:
			ts = int(float(ts_raw))
	except Exception:
		ts = _now_ms()

	payload = {"device": device, "weight": weight, "unit": unit, "stable": stable, "port": port, "ts": ts}

	ttl = _scale_cache_ttl_sec()
	cache = frappe.cache()
	cache.set_value(f"{SCALE_CACHE_PREFIX}{device_key}", payload, expires_in_sec=ttl, shared=False)
	cache.set_value(SCALE_LAST_KEY, payload, expires_in_sec=ttl, shared=False)

	published = True
	try:
		frappe.publish_realtime("rfidenter_scale_weight", payload, after_commit=False)
	except Exception:
		published = False
		frappe.log_error(title="RFIDenter scale realtime failed", message=frappe.get_traceback())

	return {"ok": True, "device": device, "published": published}


@frappe.whitelist()
def get_scale_weight(device: str | None = None) -> dict[str, Any]:
	if frappe.session.user and not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	device_key = _sanitize_agent_id(device or "")
	cache = frappe.cache()
	reading = cache.get_value(f"{SCALE_CACHE_PREFIX}{device_key}") if device_key else None
	if not reading:
		reading = cache.get_value(SCALE_LAST_KEY)

	return {"ok": bool(reading), "reading": reading or {}}


def _upsert_saved_tags(tags: list[dict[str, Any]], device: str) -> int:
	if not tags:
		return 0
	device_norm = str(device or "").strip()[:64]
	now = frappe.utils.now_datetime()
	day = now.date().isoformat()
	rows: list[tuple[Any, ...]] = []
	day_rows: list[tuple[Any, ...]] = []
	for tag in tags:
		if not isinstance(tag, dict):
			continue
		epc = _normalize_hex(tag.get("epcId") or tag.get("EPC") or "")
		if not epc:
			continue
		cnt = _normalize_count(tag.get("count") or tag.get("reads") or tag.get("readCount") or 1)
		rows.append((epc, epc, cnt, now, device_norm))
		day_name = f"{epc}-{day}"
		day_rows.append((day_name, epc, day, cnt, now, device_norm))

	if not rows:
		return 0

	values_sql = ", ".join(["(%s, %s, %s, %s, %s)"] * len(rows))
	flat: list[Any] = [item for row in rows for item in row]
	frappe.db.sql(
		f"""
		INSERT INTO `tabRFID Saved Tag` (`name`, `epc`, `reads`, `last_seen`, `device`)
		VALUES {values_sql}
		ON DUPLICATE KEY UPDATE
			`reads` = `reads` + VALUES(`reads`),
			`last_seen` = VALUES(`last_seen`),
			`device` = VALUES(`device`)
		""",
		flat,
	)

	if day_rows:
		values_day_sql = ", ".join(["(%s, %s, %s, %s, %s, %s)"] * len(day_rows))
		flat_day: list[Any] = [item for row in day_rows for item in row]
		frappe.db.sql(
			f"""
			INSERT INTO `tabRFID Saved Tag Day` (`name`, `epc`, `day`, `reads`, `last_seen`, `device`)
			VALUES {values_day_sql}
			ON DUPLICATE KEY UPDATE
				`reads` = `reads` + VALUES(`reads`),
				`last_seen` = VALUES(`last_seen`),
				`device` = VALUES(`device`)
			""",
			flat_day,
		)

	return len(rows)


@frappe.whitelist()
def get_saved_tags(limit: Any | None = None, order: Any | None = None, date: Any | None = None) -> dict[str, Any]:
	"""Fetch saved unique EPCs from DB."""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	try:
		lim = int(limit) if limit is not None else 200
	except Exception:
		lim = 200
	lim = max(50, min(10_000, lim))

	order_raw = str(order or "last").lower()
	if order_raw == "reads":
		order_by = "reads desc"
	elif order_raw == "epc":
		order_by = "epc asc"
	else:
		order_by = "last_seen desc"

	date_raw = str(date or "").strip()
	if date_raw:
		try:
			start = frappe.utils.get_datetime(date_raw)
			day = start.date().isoformat()
		except Exception:
			day = ""
		if day:
			rows = frappe.get_all(
				"RFID Saved Tag Day",
				fields=["epc", "reads", "last_seen", "device"],
				filters={"day": day},
				order_by=order_by,
				limit=lim,
			)
		else:
			rows = []
	else:
		rows = frappe.get_all(
			"RFID Saved Tag",
			fields=["epc", "reads", "last_seen", "device"],
			order_by=order_by,
			limit=lim,
		)
	return {"ok": True, "count": len(rows), "items": rows}


@frappe.whitelist()
def clear_saved_tags(date: Any | None = None) -> dict[str, Any]:
	"""Clear saved EPCs."""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	date_raw = str(date or "").strip()
	if date_raw:
		try:
			start = frappe.utils.get_datetime(date_raw)
			day = start.date().isoformat()
		except Exception:
			day = ""
		if day:
			frappe.db.delete("RFID Saved Tag Day", {"day": day})
		else:
			frappe.db.delete("RFID Saved Tag Day")
		return {"ok": True}

	frappe.db.delete("RFID Saved Tag")
	frappe.db.delete("RFID Saved Tag Day")
	return {"ok": True}

@frappe.whitelist()
def get_tag_notes(epcs: Any | None = None, limit: Any | None = None) -> dict[str, Any]:
	"""Fetch EPC notes from DB. If `epcs` provided, returns only those."""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	items: list[str] = []
	if epcs:
		if isinstance(epcs, str):
			try:
				parsed = json.loads(epcs)
				epcs = parsed if isinstance(parsed, list) else [epcs]
			except Exception:
				epcs = [x.strip() for x in epcs.split(",") if x.strip()]
		if not isinstance(epcs, list):
			epcs = [epcs]
		for item in epcs:
			epc = _normalize_hex(item)
			if epc:
				items.append(epc)

	try:
		lim = int(limit) if limit is not None else 2000
	except Exception:
		lim = 2000
	lim = max(10, min(10_000, lim))

	filters = {"epc": ["in", items]} if items else {}
	rows = frappe.get_all("RFID Tag Note", fields=["epc", "note"], filters=filters, limit=lim)
	notes = {str(r.get("epc") or ""): str(r.get("note") or "") for r in rows}
	return {"ok": True, "count": len(notes), "notes": notes}


@frappe.whitelist()
def set_tag_note(epc: str, note: str | None = None, device: str | None = None) -> dict[str, Any]:
	"""Create/update/delete an EPC note."""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	epc_norm = _normalize_hex(epc)
	if not epc_norm:
		frappe.throw("EPC noto‘g‘ri.", frappe.ValidationError)

	note_norm = _normalize_note(note)
	device_norm = str(device or "").strip()[:64]

	name = frappe.db.get_value("RFID Tag Note", {"epc": epc_norm}, "name")
	if not note_norm:
		if name:
			frappe.delete_doc("RFID Tag Note", name, ignore_permissions=True)
		return {"ok": True, "epc": epc_norm, "deleted": True}

	if name:
		doc = frappe.get_doc("RFID Tag Note", name)
		doc.note = note_norm
		if device_norm:
			doc.device = device_norm
		doc.save(ignore_permissions=True)
	else:
		doc = frappe.get_doc(
			{
				"doctype": "RFID Tag Note",
				"epc": epc_norm,
				"note": note_norm,
				"device": device_norm,
			}
		)
		doc.insert(ignore_permissions=True)

	return {"ok": True, "epc": epc_norm, "note": note_norm}


@frappe.whitelist()
def generate_user_token(rotate: Any | None = None) -> dict[str, Any]:
	"""
	Get (or optionally rotate) API key+secret for the current user.

	Used for configuring the local Node agent:
	  Authorization: token <api_key>:<api_secret>
	"""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	user = frappe.session.user
	if not user or user == "Guest":
		frappe.throw("Login qiling.", frappe.PermissionError)

	user_doc = frappe.get_doc("User", user)

	rotate_raw = str(rotate or "").strip().lower()
	should_rotate = rotate_raw in ("1", "true", "yes", "y", "on")

	changed = False
	if not user_doc.api_key:
		user_doc.api_key = frappe.generate_hash(length=15)
		changed = True

	api_secret = ""
	try:
		api_secret = get_decrypted_password("User", user, "api_secret", raise_exception=False) or ""
	except Exception:
		api_secret = ""

	if should_rotate or not api_secret:
		api_secret = frappe.generate_hash(length=15)
		user_doc.api_secret = api_secret
		changed = True

	if changed:
		user_doc.save(ignore_permissions=True)

	return {
		"ok": True,
		"user": user,
		"api_key": user_doc.api_key,
		"api_secret": api_secret,
		"authorization": f"token {user_doc.api_key}:{api_secret}",
		"rotated": bool(should_rotate),
	}


@frappe.whitelist(allow_guest=True)
def register_agent(**kwargs) -> dict[str, Any]:
	"""
	Register/heartbeat a local Node RFID agent (bridge).

	Node tarafdan yuboriladigan tavsiya payload:
	{
	  "agent_id": "pc-1",
	  "device": "pc-1",
	  "ui_urls": ["http://192.168.1.10:8787", "http://127.0.0.1:8787"],
	  "ui_port": 8787,
	  "ui_host": "0.0.0.0",
	  "platform": "linux",
	  "version": "rfid-web-localhost",
	  "ts": 1730000000000
	}
	"""
	_require_auth_for_ingest()
	if frappe.session.user and frappe.session.user != "Guest" and not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	body = {}
	try:
		body = frappe.request.get_json(silent=True) or {}
	except Exception:
		body = {}

	if not body:
		try:
			body = dict(frappe.local.form_dict or {})
		except Exception:
			body = {}
		body.update(kwargs or {})

	device = str(body.get("device") or body.get("hostname") or "unknown").strip() or "unknown"
	agent_id = _sanitize_agent_id(body.get("agent_id") or device) or _sanitize_agent_id(device)
	if not agent_id:
		agent_id = _sanitize_agent_id(getattr(frappe.local, "request_ip", "") or "agent")

	ui_urls = body.get("ui_urls")
	if isinstance(ui_urls, str):
		try:
			ui_urls = json.loads(ui_urls)
		except Exception:
			ui_urls = [ui_urls]
	if ui_urls is None:
		ui_urls = []
	if not isinstance(ui_urls, list):
		ui_urls = [ui_urls]

	clean_urls: list[str] = []
	for u in ui_urls:
		s = str(u or "").strip()
		if not s:
			continue
		clean_urls.append(s.rstrip("/"))
	clean_urls = clean_urls[:10]

	payload: dict[str, Any] = {
		"agent_id": agent_id,
		"device": device,
		"ui_urls": clean_urls,
		"ui_host": str(body.get("ui_host") or "").strip(),
		"ui_port": body.get("ui_port"),
		"platform": str(body.get("platform") or "").strip(),
		"version": str(body.get("version") or "").strip(),
		"pid": body.get("pid"),
		"request_ip": str(getattr(frappe.local, "request_ip", "") or "").strip(),
		"user": frappe.session.user,
		"last_seen": _now_ms(),
	}

	frappe.cache().hset(AGENT_CACHE_HASH, agent_id, payload)
	return {"ok": True, "agent": payload}


@frappe.whitelist()
def list_agents() -> dict[str, Any]:
	"""List online agents recently seen via register_agent()."""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	ttl_sec = _agent_ttl_sec()
	cutoff = _now_ms() - (ttl_sec * 1000)

	raw = frappe.cache().hgetall(AGENT_CACHE_HASH) or {}

	agents: list[dict[str, Any]] = []
	stale_keys: list[str] = []
	for k, v in raw.items():
		agent_key = k.decode() if isinstance(k, (bytes, bytearray)) else str(k)
		if not isinstance(v, dict):
			continue
		last_seen = int(v.get("last_seen") or 0)
		if last_seen < cutoff:
			stale_keys.append(agent_key)
			continue
		agents.append(v)

	for key in stale_keys:
		try:
			frappe.cache().hdel(AGENT_CACHE_HASH, key)
		except Exception:
			pass

	agents.sort(key=lambda a: int(a.get("last_seen") or 0), reverse=True)
	return {"ok": True, "ttl_sec": ttl_sec, "agents": agents}


@frappe.whitelist()
def agent_enqueue(
	agent_id: str = "",
	command: str = "",
	args: Any | None = None,
	timeout_sec: Any | None = None,
	**kwargs,
) -> dict[str, Any]:
	"""
	Enqueue an RPC command for a given agent.

	Returns `request_id`, then UI can poll `agent_result(request_id)` (or listen to realtime event).
	"""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	user = frappe.session.user
	if not user or user == "Guest":
		frappe.throw("Login qiling.", frappe.PermissionError)

	agent = _sanitize_agent_id(agent_id)
	if not agent:
		frappe.throw("agent_id noto‘g‘ri.", frappe.ValidationError)

	# IMPORTANT: don't use request arg name `cmd` (reserved in Frappe API).
	cmd_value = command or kwargs.get("command") or ""
	command_str = str(cmd_value or "").strip()
	if not command_str:
		frappe.throw("command bo‘sh bo‘lmasin.", frappe.ValidationError)

	if isinstance(args, str):
		try:
			args = json.loads(args)
		except Exception:
			args = {}
	if args is None:
		args = {}
	if not isinstance(args, dict):
		args = {"value": args}

	timeout = _rpc_timeout_sec(timeout_sec)
	ts = _now_ms()

	request_id = frappe.generate_hash(length=20)
	req = {
		"request_id": request_id,
		"agent_id": agent,
		"cmd": command_str,
		"args": args,
		"requested_by": user,
		"ts": ts,
		"timeout_sec": timeout,
	}

	queue_key = f"{AGENT_QUEUE_PREFIX}{agent}"
	req_key = f"{AGENT_REQ_PREFIX}{request_id}"

	frappe.cache().rpush(queue_key, json.dumps(req, separators=(",", ":")))
	frappe.cache().set_value(req_key, req, expires_in_sec=_rpc_store_ttl_sec(timeout), shared=False)

	return {"ok": True, "request_id": request_id, "timeout_sec": timeout}


@frappe.whitelist()
def agent_poll(agent_id: str = "", max_items: Any | None = None, **kwargs) -> dict[str, Any]:
	"""
	Agent-side: poll for queued commands.

	Node agent calls this frequently (poll loop).
	"""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	user = frappe.session.user
	if not user or user == "Guest":
		frappe.throw("Login qiling.", frappe.PermissionError)

	agent = _sanitize_agent_id(agent_id)
	if not agent:
		frappe.throw("agent_id noto‘g‘ri.", frappe.ValidationError)

	if max_items is None:
		max_items = kwargs.get("max") or kwargs.get("limit")

	try:
		limit = int(max_items) if max_items is not None else 5
	except Exception:
		limit = 5
	limit = max(1, min(25, limit))

	queue_key = f"{AGENT_QUEUE_PREFIX}{agent}"
	commands: list[dict[str, Any]] = []

	for _ in range(limit):
		raw = frappe.cache().lpop(queue_key)
		if not raw:
			break
		if isinstance(raw, (bytes, bytearray)):
			raw = raw.decode("utf-8", errors="ignore")
		try:
			obj = json.loads(str(raw))
		except Exception:
			continue
		if isinstance(obj, dict):
			commands.append(obj)

	return {"ok": True, "agent_id": agent, "commands": commands}


@frappe.whitelist()
def agent_reply(
	agent_id: str = "",
	request_id: str = "",
	ok: Any | None = None,
	result: Any | None = None,
	error: str | None = None,
) -> dict[str, Any]:
	"""
	Agent-side: post RPC result for a request.

	Will publish realtime event `rfidenter_agent_reply` to the requesting user (if known).
	"""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	user = frappe.session.user
	if not user or user == "Guest":
		frappe.throw("Login qiling.", frappe.PermissionError)

	agent = _sanitize_agent_id(agent_id)
	if not agent:
		frappe.throw("agent_id noto‘g‘ri.", frappe.ValidationError)

	rid = str(request_id or "").strip()
	if not rid:
		frappe.throw("request_id bo‘sh.", frappe.ValidationError)

	req_key = f"{AGENT_REQ_PREFIX}{rid}"
	meta = frappe.cache().get_value(req_key) or {}
	timeout = _rpc_timeout_sec(meta.get("timeout_sec") if isinstance(meta, dict) else None)

	is_ok = bool(ok) if ok is not None else error is None
	reply = {
		"request_id": rid,
		"agent_id": agent,
		"ok": is_ok,
		"result": result if is_ok else None,
		"error": str(error or "") if not is_ok else "",
		"ts": _now_ms(),
	}

	reply_key = f"{AGENT_REPLY_PREFIX}{rid}"
	frappe.cache().set_value(reply_key, reply, expires_in_sec=_rpc_store_ttl_sec(timeout), shared=False)

	# Realtime notify requester (optional). This does not depend on DB commits.
	try:
		req_user = meta.get("requested_by") if isinstance(meta, dict) else None
		if req_user:
			frappe.publish_realtime("rfidenter_agent_reply", reply, user=req_user, after_commit=False)
	except Exception:
		frappe.log_error(title="RFIDenter agent_reply publish failed", message=frappe.get_traceback())

	return {"ok": True}


@frappe.whitelist()
def agent_result(request_id: str = "") -> dict[str, Any]:
	"""UI-side: check result of a queued request."""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	user = frappe.session.user
	if not user or user == "Guest":
		frappe.throw("Login qiling.", frappe.PermissionError)

	rid = str(request_id or "").strip()
	if not rid:
		frappe.throw("request_id bo‘sh.", frappe.ValidationError)

	req_key = f"{AGENT_REQ_PREFIX}{rid}"
	meta = frappe.cache().get_value(req_key)
	if not meta or not isinstance(meta, dict):
		return {"ok": True, "state": "expired"}

	req_user = str(meta.get("requested_by") or "").strip()
	if req_user and req_user != user and not frappe.has_role("System Manager"):
		frappe.throw("Siz bu request natijasini ko‘ra olmaysiz.", frappe.PermissionError)

	reply_key = f"{AGENT_REPLY_PREFIX}{rid}"
	reply = frappe.cache().get_value(reply_key)
	if reply and isinstance(reply, dict):
		return {"ok": True, "state": "done", "reply": reply}

	return {"ok": True, "state": "pending"}


@frappe.whitelist()
def zebra_create_item_tag(
	item_code: str,
	qty: Any | None = None,
	uom: str | None = None,
	consume_ant_id: Any | None = None,
	client_request_id: str | None = None,
) -> dict[str, Any]:
	"""Create a Zebra EPC tag record for an Item.

	The UI will then print the EPC using Zebra agent/local URL. This stores the mapping in DB.
	"""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	return zebra_items.create_item_tag(
		item_code=item_code,
		qty=qty,
		uom=uom,
		consume_ant_id=consume_ant_id,
		client_request_id=client_request_id,
		requested_by=frappe.session.user,
	)


@frappe.whitelist()
def zebra_mark_tag_printed(epc: str) -> dict[str, Any]:
	"""Mark a Zebra tag as printed (for UI visibility/debug)."""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)
	return zebra_items.mark_tag_printed(epc=epc)


@frappe.whitelist()
def zebra_list_tags(limit: Any | None = None) -> dict[str, Any]:
	"""List recent Zebra tags from DB."""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)
	return zebra_items.list_recent_tags(limit=limit)


@frappe.whitelist()
def zebra_list_epcs(statuses: Any | None = None, limit: Any | None = None) -> dict[str, Any]:
	"""List EPCs that belong to Zebra-printed tags."""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	status_list: list[str] = []
	if statuses:
		if isinstance(statuses, str):
			try:
				parsed = json.loads(statuses)
				statuses = parsed if isinstance(parsed, list) else [statuses]
			except Exception:
				statuses = [x.strip() for x in statuses.split(",") if x.strip()]
		if not isinstance(statuses, list):
			statuses = [statuses]
		status_list = [str(s or "").strip() for s in statuses if str(s or "").strip()]

	if not status_list:
		status_list = ["Printed", "Processing", "Consumed"]

	try:
		lim = int(limit) if limit is not None else 10000
	except Exception:
		lim = 10000
	lim = max(100, min(100000, lim))

	rows = frappe.get_all(
		"RFID Zebra Tag",
		fields=["epc"],
		filters={"status": ["in", status_list]},
		order_by="modified desc",
		limit=lim,
	)
	epcs = [_normalize_hex(r.get("epc")) for r in rows if _normalize_hex(r.get("epc"))]
	return {"ok": True, "count": len(epcs), "epcs": epcs}


@frappe.whitelist()
def zebra_epc_info(epcs: Any | None = None, limit: Any | None = None) -> dict[str, Any]:
	"""Fetch Zebra tag metadata (including Stock Entry) for given EPCs."""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	items: list[str] = []
	if epcs:
		if isinstance(epcs, str):
			try:
				parsed = json.loads(epcs)
				epcs = parsed if isinstance(parsed, list) else [epcs]
			except Exception:
				epcs = [x.strip() for x in epcs.split(",") if x.strip()]
		if not isinstance(epcs, list):
			epcs = [epcs]
		for item in epcs:
			epc = _normalize_hex(item)
			if epc:
				items.append(epc)

	try:
		lim = int(limit) if limit is not None else len(items) or 0
	except Exception:
		lim = len(items) or 0
	lim = max(1, min(5000, lim))

	uniq: list[str] = []
	seen: set[str] = set()
	for epc in items:
		if epc in seen:
			continue
		seen.add(epc)
		uniq.append(epc)
		if len(uniq) >= lim:
			break

	if not uniq:
		return {"ok": True, "count": 0, "items": []}

	rows = frappe.get_all(
		"RFID Zebra Tag",
		fields=["epc", "status", "purchase_receipt", "item_code", "item_name", "qty", "uom"],
		filters={"epc": ["in", uniq]},
		limit=len(uniq),
	)

	row_map: dict[str, dict[str, Any]] = {}
	for row in rows:
		epc = _normalize_hex(row.get("epc"))
		if not epc:
			continue
		row_map[epc] = {
			"epc": epc,
			"stock_entry": row.get("purchase_receipt") or "",
			"status": row.get("status") or "",
			"item_code": row.get("item_code") or "",
			"item_name": row.get("item_name") or "",
			"qty": row.get("qty") or 0,
			"uom": row.get("uom") or "",
		}

	out = [row_map[epc] for epc in uniq if epc in row_map]
	return {"ok": True, "count": len(out), "items": out}
