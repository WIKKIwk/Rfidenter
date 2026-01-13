from __future__ import annotations

import frappe

from rfidenter.rfidenter import api as _api

__version__ = "0.0.1"


@frappe.whitelist()
def edge_batch_start(**kwargs):
	return _api.edge_batch_start(**kwargs)


@frappe.whitelist()
def edge_batch_stop(**kwargs):
	return _api.edge_batch_stop(**kwargs)


@frappe.whitelist()
def edge_event_report(**kwargs):
	return _api.edge_event_report(**kwargs)


@frappe.whitelist()
def device_status(**kwargs):
	return _api.device_status(**kwargs)


@frappe.whitelist()
def edge_product_switch(**kwargs):
	return _api.edge_product_switch(**kwargs)


@frappe.whitelist()
def agent_enqueue(**kwargs):
	return _api.agent_enqueue(**kwargs)


@frappe.whitelist()
def agent_poll(**kwargs):
	return _api.agent_poll(**kwargs)


@frappe.whitelist()
def agent_reply(**kwargs):
	return _api.agent_reply(**kwargs)


@frappe.whitelist()
def agent_result(**kwargs):
	return _api.agent_result(**kwargs)
