from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase
from erpnext.stock.doctype.item.test_item import create_item

from rfidenter.rfidenter import api
from rfidenter.rfidenter import zebra_items


class TestEdgeEvents(FrappeTestCase):
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

	def test_event_report_duplicate_by_event_id(self) -> None:
		event_id = "evt-name-mismatch"
		frappe.db.delete("RFID Edge Event", {"event_id": event_id})

		doc = frappe.get_doc(
			{
				"doctype": "RFID Edge Event",
				"event_id": event_id,
				"device_id": self.device_id,
				"batch_id": self.batch_id,
				"seq": 1,
				"event_type": "event_report",
				"payload_json": "{}",
				"payload_hash": "",
				"received_at": frappe.utils.now_datetime(),
				"processed": 0,
			}
		).insert(ignore_permissions=True)

		new_name = f"EDGE-{frappe.generate_hash(length=8)}"
		frappe.rename_doc("RFID Edge Event", doc.name, new_name, force=True)
		frappe.db.set_value(
			"RFID Edge Event",
			new_name,
			"event_id",
			event_id,
			update_modified=False,
		)

		res = api.edge_event_report(
			event_id=event_id,
			device_id=self.device_id,
			batch_id=self.batch_id,
			seq=2,
			event_type="weight",
			payload={"value": 1.0},
		)
		self.assertTrue(res.get("duplicate"))
		self.assertEqual(frappe.db.count("RFID Edge Event", {"event_id": event_id}), 1)

	def test_seq_regression_rejected(self) -> None:
		api.edge_event_report(
			event_id="evt-2",
			device_id=self.device_id,
			batch_id=self.batch_id,
			seq=2,
			event_type="weight",
			payload={"value": 2.0},
		)
		frappe.local.response = frappe._dict()
		res = api.edge_event_report(
			event_id="evt-3",
			device_id=self.device_id,
			batch_id=self.batch_id,
			seq=1,
			event_type="weight",
			payload={"value": 1.0},
		)
		self.assertFalse(res.get("ok"))
		self.assertEqual(res.get("code"), "SEQ_REGRESSION")
		self.assertEqual(frappe.local.response.get("http_status_code"), 409)

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
		company = frappe.db.get_value("Company", {}, "name")
		warehouse = frappe.db.get_value("Warehouse", {"company": company}, "name") if company else None
		if not company or not warehouse:
			self.skipTest("Requires existing Company and Warehouse")

		supplier = frappe.db.get_value("Supplier", {"supplier_name": "_RFID Test Supplier"}, "name")
		if not supplier:
			supplier = (
				frappe.get_doc({"doctype": "Supplier", "supplier_name": "_RFID Test Supplier"})
				.insert(ignore_permissions=True)
				.name
			)

		customer = frappe.db.get_value("Customer", {"customer_name": "_RFID Test Customer"}, "name")
		if not customer:
			customer = (
				frappe.get_doc({"doctype": "Customer", "customer_name": "_RFID Test Customer"})
				.insert(ignore_permissions=True)
				.name
			)

		item_code = "_RFID Dedupe Item"
		item = create_item(item_code, is_stock_item=1, warehouse=warehouse, company=company)
		uom = item.stock_uom

		if not frappe.db.exists("RFID Zebra Item Receipt Setting", {"item_code": item_code}):
			frappe.get_doc(
				{
					"doctype": "RFID Zebra Item Receipt Setting",
					"item_code": item_code,
					"company": company,
					"supplier": supplier,
					"warehouse": warehouse,
					"submit_purchase_receipt": 0,
				}
			).insert(ignore_permissions=True)

		if not frappe.db.exists("RFID Delivery Note Setting", {"item_code": item_code}):
			frappe.get_doc(
				{
					"doctype": "RFID Delivery Note Setting",
					"item_code": item_code,
					"company": company,
					"customer": customer,
					"warehouse": warehouse,
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

	def test_zebra_dedupe_stale_claim_recovered(self) -> None:
		company = frappe.db.get_value("Company", {}, "name")
		warehouse = frappe.db.get_value("Warehouse", {"company": company}, "name") if company else None
		if not company or not warehouse:
			self.skipTest("Requires existing Company and Warehouse")

		supplier = frappe.db.get_value("Supplier", {"supplier_name": "_RFID Test Supplier"}, "name")
		if not supplier:
			supplier = (
				frappe.get_doc({"doctype": "Supplier", "supplier_name": "_RFID Test Supplier"})
				.insert(ignore_permissions=True)
				.name
			)

		customer = frappe.db.get_value("Customer", {"customer_name": "_RFID Test Customer"}, "name")
		if not customer:
			customer = (
				frappe.get_doc({"doctype": "Customer", "customer_name": "_RFID Test Customer"})
				.insert(ignore_permissions=True)
				.name
			)

		item_code = "_RFID Dedupe Stale"
		item = create_item(item_code, is_stock_item=1, warehouse=warehouse, company=company)
		uom = item.stock_uom

		if not frappe.db.exists("RFID Zebra Item Receipt Setting", {"item_code": item_code}):
			frappe.get_doc(
				{
					"doctype": "RFID Zebra Item Receipt Setting",
					"item_code": item_code,
					"company": company,
					"supplier": supplier,
					"warehouse": warehouse,
					"submit_purchase_receipt": 0,
				}
			).insert(ignore_permissions=True)

		frappe.db.delete("RFID Zebra Dedupe", {"idempotency_key": "stock_entry:idem-stale"})

		claim, created = zebra_items._claim_dedupe(
			"idem-stale",
			kind="stock_entry",
			payload_hash="",
			raw_key="idem-stale",
			key_type="event_id",
			epc="EPC9999",
		)
		self.assertTrue(created)
		stale_at = frappe.utils.add_to_date(frappe.utils.now_datetime(), seconds=-300)
		frappe.db.set_value(
			"RFID Zebra Dedupe",
			claim.name,
			{"status": "CLAIMED", "claimed_at": stale_at, "doc_name": "", "doc_type": ""},
			update_modified=False,
		)

		tag = {"epc": "EPC9999", "item_code": item_code, "qty": 1, "uom": uom}
		doc1 = zebra_items._create_stock_entry_draft_for_tag(
			tag, ant_id=1, device="test", idempotency_key="idem-stale", key_type="event_id"
		)
		doc2 = zebra_items._create_stock_entry_draft_for_tag(
			tag, ant_id=1, device="test", idempotency_key="idem-stale", key_type="event_id"
		)
		self.assertEqual(doc1, doc2)
		self.assertEqual(frappe.db.count("Stock Entry", {"name": doc1}), 1)
