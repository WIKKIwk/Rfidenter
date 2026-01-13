from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase
from erpnext.accounts.test.accounts_mixin import AccountsTestMixin
from erpnext.stock.doctype.item.test_item import create_item

from rfidenter.rfidenter import api
from rfidenter.rfidenter import zebra_items


class TestEdgeEvents(FrappeTestCase, AccountsTestMixin):
	def setUp(self) -> None:
		frappe.set_user("Administrator")
		self.device_id = "test-device"
		self.batch_id = "batch-1"
		self.agent_id = "agent-1"
		frappe.db.delete("RFID Edge Event", {"device_id": self.device_id})
		frappe.db.delete("RFID Batch State", {"device_id": self.device_id})
		frappe.db.delete("RFID Agent Request", {"agent_id": self.agent_id})

	def test_event_report_idempotent(self) -> None:
		args = {
			"event_id": "evt-1",
			"device_id": self.device_id,
			"batch_id": self.batch_id,
			"seq": 1,
			"event_type": "weight",
			"payload": {"value": 1.0},
		}
		res1 = api.edge_event_report(**args)
		self.assertTrue(res1.get("ok"))
		res2 = api.edge_event_report(**args)
		self.assertTrue(res2.get("duplicate"))
		state = frappe.get_doc("RFID Batch State", {"device_id": self.device_id})
		self.assertEqual(int(state.last_event_seq or 0), 1)

	def test_seq_regression_rejected(self) -> None:
		api.edge_event_report(
			event_id="evt-2",
			device_id=self.device_id,
			batch_id=self.batch_id,
			seq=2,
			event_type="weight",
			payload={"value": 2.0},
		)
		with self.assertRaises(frappe.ValidationError):
			api.edge_event_report(
				event_id="evt-3",
				device_id=self.device_id,
				batch_id=self.batch_id,
				seq=1,
				event_type="weight",
				payload={"value": 1.0},
			)

	def test_batch_start_stop_sets_state(self) -> None:
		api.edge_batch_start(
			event_id="evt-4",
			device_id=self.device_id,
			batch_id=self.batch_id,
			seq=1,
		)
		state = frappe.get_doc("RFID Batch State", {"device_id": self.device_id})
		self.assertEqual(state.status, "Running")
		self.assertEqual(state.current_batch_id, self.batch_id)

		api.edge_batch_stop(
			event_id="evt-5",
			device_id=self.device_id,
			batch_id=self.batch_id,
			seq=2,
		)
		state.reload()
		self.assertEqual(state.status, "Stopped")

	def test_agent_queue_persists(self) -> None:
		res = api.agent_enqueue(agent_id=self.agent_id, command="ping", args={"a": 1}, timeout_sec=5)
		request_id = res.get("request_id")
		self.assertTrue(request_id)
		self.assertTrue(frappe.db.exists("RFID Agent Request", request_id))

		frappe.clear_cache()
		poll = api.agent_poll(agent_id=self.agent_id, max_items=1)
		commands = poll.get("commands") or []
		self.assertEqual(len(commands), 1)
		self.assertEqual(commands[0].get("request_id"), request_id)

	def test_agent_queue_lease_reclaim(self) -> None:
		res = api.agent_enqueue(agent_id=self.agent_id, command="ping", args={"a": 1}, timeout_sec=1)
		request_id = res.get("request_id")
		self.assertTrue(request_id)

		expired_at = frappe.utils.add_to_date(frappe.utils.now_datetime(), seconds=-5)
		frappe.db.set_value(
			"RFID Agent Request",
			request_id,
			{"status": "Sent", "lease_expires_at": expired_at},
			update_modified=False,
		)

		poll = api.agent_poll(agent_id=self.agent_id, max_items=1)
		commands = poll.get("commands") or []
		self.assertEqual(len(commands), 1)
		self.assertEqual(commands[0].get("request_id"), request_id)

	def test_zebra_dedupe_claim_first(self) -> None:
		self.create_company()
		self.create_supplier()
		self.create_customer()

		item_code = "_RFID Dedupe Item"
		item = create_item(item_code, is_stock_item=1, warehouse=self.warehouse, company=self.company)
		uom = item.stock_uom

		if not frappe.db.exists("RFID Zebra Item Receipt Setting", {"item_code": item_code}):
			frappe.get_doc(
				{
					"doctype": "RFID Zebra Item Receipt Setting",
					"item_code": item_code,
					"company": self.company,
					"supplier": self.supplier,
					"warehouse": self.warehouse,
					"submit_purchase_receipt": 0,
				}
			).insert(ignore_permissions=True)

		if not frappe.db.exists("RFID Delivery Note Setting", {"item_code": item_code}):
			frappe.get_doc(
				{
					"doctype": "RFID Delivery Note Setting",
					"item_code": item_code,
					"company": self.company,
					"customer": self.customer,
					"warehouse": self.warehouse,
					"default_rate": 0,
				}
			).insert(ignore_permissions=True)

		frappe.db.delete("RFID Zebra Dedupe", {"idempotency_key": "stock_entry:idem-1"})

		tag = {"epc": "EPC1234", "item_code": item_code, "qty": 1, "uom": uom}
		doc1 = zebra_items._create_stock_entry_draft_for_tag(
			tag, ant_id=1, device="test", idempotency_key="idem-1", key_type="event_id"
		)
		doc2 = zebra_items._create_stock_entry_draft_for_tag(
			tag, ant_id=1, device="test", idempotency_key="idem-1", key_type="event_id"
		)
		self.assertEqual(doc1, doc2)
		self.assertEqual(frappe.db.count("Stock Entry", {"name": doc1}), 1)
