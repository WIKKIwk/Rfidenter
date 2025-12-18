from __future__ import annotations

import json
import re
import time
from typing import Any

import frappe

from rfidenter.rfidenter.permissions import has_rfidenter_access

AGENT_CACHE_HASH = "rfidenter_agents"
AGENT_QUEUE_PREFIX = "rfidenter_agent_queue:"
AGENT_REQ_PREFIX = "rfidenter_agent_req:"
AGENT_REPLY_PREFIX = "rfidenter_agent_reply:"
SEEN_PREFIX = "rfidenter_seen:"


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


def _sanitize_agent_id(raw: str) -> str:
	s = str(raw or "").strip()
	if not s:
		return ""
	s = s.lower()
	s = re.sub(r"[^a-z0-9._-]+", "-", s)
	s = re.sub(r"-{2,}", "-", s).strip("-")
	return s[:64]


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

	unique_tags: list[Any] = []
	skipped = 0
	if dedup_enabled:
		cache = frappe.cache()
		for tag in tags:
			if not isinstance(tag, dict):
				unique_tags.append(tag)
				continue

			epc = _normalize_hex(tag.get("epcId") or tag.get("EPC") or "")
			ant = _normalize_ant(tag.get("antId") or tag.get("ANT") or 0)
			if not epc or ant <= 0:
				unique_tags.append(tag)
				continue

			key = f"{SEEN_PREFIX}{dedup_device}:{ant}:{epc}"
			seen = cache.get_value(key, expires=True)
			if seen:
				skipped += 1
				continue
			cache.set_value(key, 1, expires_in_sec=dedup_ttl)
			unique_tags.append(tag)
	else:
		unique_tags = tags

	payload = {"device": device, "ts": ts, "tags": unique_tags}
	# Broadcast to all logged-in desk users.
	published = True
	try:
		frappe.publish_realtime("rfidenter_tag_batch", payload, after_commit=False)
	except Exception:
		published = False
		frappe.log_error(title="RFIDenter publish_realtime failed", message=frappe.get_traceback())

	return {
		"ok": True,
		"received": len(tags),
		"unique": len(unique_tags),
		"skipped": skipped,
		"dedup_by_ant": dedup_enabled,
		"dedup_ttl_sec": dedup_ttl,
		"published": published,
	}


@frappe.whitelist()
def generate_user_token() -> dict[str, Any]:
	"""
	Generate/rotate API key+secret for the current user.

	Used for configuring the local Node agent:
	  Authorization: token <api_key>:<api_secret>
	"""
	if not has_rfidenter_access():
		frappe.throw("RFIDenter: sizda RFIDer roli yo‘q.", frappe.PermissionError)

	user = frappe.session.user
	if not user or user == "Guest":
		frappe.throw("Login qiling.", frappe.PermissionError)

	user_doc = frappe.get_doc("User", user)
	if not user_doc.api_key:
		user_doc.api_key = frappe.generate_hash(length=15)

	api_secret = frappe.generate_hash(length=15)
	user_doc.api_secret = api_secret
	user_doc.save(ignore_permissions=True)

	return {
		"ok": True,
		"user": user,
		"api_key": user_doc.api_key,
		"api_secret": api_secret,
		"authorization": f"token {user_doc.api_key}:{api_secret}",
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
