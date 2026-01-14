from __future__ import annotations

import frappe
from frappe.utils.password import get_decrypted_password


RFIDENTER_ROLE = "RFIDer"


def has_rfidenter_access(user: str | None = None) -> bool:
	user = user or frappe.session.user
	if user and user != "Guest":
		roles = frappe.get_roles(user)
		return (RFIDENTER_ROLE in roles) or ("System Manager" in roles)

	site_token = _get_site_token()
	if site_token:
		for token in _get_request_tokens():
			if token == site_token:
				return True

	for token in _get_request_tokens():
		user_from_token = _user_from_api_token(token)
		if not user_from_token:
			continue
		roles = frappe.get_roles(user_from_token)
		if (RFIDENTER_ROLE in roles) or ("System Manager" in roles):
			return True

	return False


def _get_site_token() -> str:
	conf = getattr(frappe, "conf", None) or {}
	if isinstance(conf, dict) and "rfidenter_token" in conf:
		return str(conf.get("rfidenter_token") or "").strip()
	site_conf = frappe.get_site_config() or {}
	if isinstance(site_conf, dict) and "rfidenter_token" in site_conf:
		return str(site_conf.get("rfidenter_token") or "").strip()
	return ""


def _get_request_tokens() -> list[str]:
	tokens: list[str] = []
	auth = frappe.get_request_header("Authorization")
	if auth:
		tokens.append(str(auth).strip())
	for key in ("X-RFIDenter-Token", "X-RFIDENTER-TOKEN"):
		value = frappe.get_request_header(key)
		if value:
			tokens.append(str(value).strip())
	return [t for t in tokens if t]


def _user_from_api_token(raw: str) -> str | None:
	raw = str(raw or "").strip()
	if not raw:
		return None
	if raw.lower().startswith("token "):
		raw = raw[6:].strip()
	if ":" not in raw:
		return None
	api_key, api_secret = raw.split(":", 1)
	if not api_key or not api_secret:
		return None
	user = frappe.db.get_value("User", {"api_key": api_key}, "name")
	if not user:
		return None
	secret = get_decrypted_password("User", user, "api_secret", raise_exception=False) or ""
	return user if secret == api_secret else None


def has_app_permission() -> bool:
	"""Hook: used by `add_to_apps_screen` to decide if RFIDenter shows in /apps."""
	return has_rfidenter_access()
