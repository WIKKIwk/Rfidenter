from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from erpnext.stock.doctype.item.test_item import create_item
from erpnext.accounts.test.accounts_mixin import AccountsTestMixin

from rfidenter.rfidenter import api
from rfidenter.rfidenter import zebra_items


class TestAntennaFlow(FrappeTestCase, AccountsTestMixin):
	EPC_PREFIX = "E2AB"

	def setUp(self) -> None:
		frappe.set_user("Administrator")
		companies = frappe.db.get_all("Company", pluck="name", limit=1)
		if not companies:
			self.fail("No Company found for RFID antenna tests.")
		self.company = companies[0]
		warehouses = frappe.db.get_all("Warehouse", filters={"company": self.company}, pluck="name", limit=1)
		if not warehouses:
			self.fail("No Warehouse found for RFID antenna tests.")
		self.warehouse = warehouses[0]
		self.create_supplier(supplier_name="_RFID Test Supplier")
		self.create_customer(customer_name="_RFID Test Customer")
		self.device_id = "ant-device-test"
		self.batch_id = "ant-batch-test"
		frappe.db.delete("RFID Edge Event", {"device_id": self.device_id})
		frappe.db.delete("RFID Batch State", {"device_id": self.device_id})
		frappe.db.delete("RFID Zebra Tag", {"epc": ["like", f"{self.EPC_PREFIX}%"]})
		frappe.db.delete("RFID Antenna Rule", {"device": self.device_id})

	def _ensure_master_data(self, item_code: str) -> str:
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

		return uom

	def _ensure_rule(self) -> None:
		if not frappe.db.exists("RFID Antenna Rule", {"device": self.device_id, "antenna_id": 1}):
			frappe.get_doc(
				{
					"doctype": "RFID Antenna Rule",
					"device": self.device_id,
					"antenna_id": 1,
					"submit_stock_entry": 1,
					"create_delivery_note": 0,
					"submit_delivery_note": 0,
				}
			).insert(ignore_permissions=True)

	def _create_tag(
		self,
		*,
		epc: str,
		item_code: str,
		uom: str,
		status: str,
		printed: bool,
		scan_recon_required: int = 0,
	) -> None:
		kwargs = {
			"doctype": "RFID Zebra Tag",
			"epc": epc,
			"item_code": item_code,
			"qty": 1,
			"uom": uom,
			"consume_ant_id": 1,
			"status": status,
			"scan_recon_required": scan_recon_required,
		}
		if printed:
			kwargs["printed_at"] = frappe.utils.now_datetime()
		frappe.get_doc(kwargs).insert(ignore_permissions=True)

	def test_ingest_tags_without_event_id_no_stock_entry(self) -> None:
		item_code = "_RFID ANT NOEVENT"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = f"{self.EPC_PREFIX}000000000001"
		self._create_tag(epc=epc, item_code=item_code, uom=uom, status="Printed", printed=True)

		res = api.ingest_tags(device=self.device_id, tags=[{"epcId": epc, "antId": 1, "count": 1}])
		self.assertTrue(res.get("ok"))
		self.assertFalse(frappe.db.get_value("RFID Zebra Tag", epc, "purchase_receipt"))

	def test_ingest_tags_requires_print_complete(self) -> None:
		item_code = "_RFID ANT NOTPRINTED"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = f"{self.EPC_PREFIX}000000000002"
		self._create_tag(epc=epc, item_code=item_code, uom=uom, status="Pending Print", printed=False)

		res = api.ingest_tags(
			device=self.device_id,
			event_id="evt-ant-1",
			batch_id=self.batch_id,
			seq=1,
			tags=[{"epcId": epc, "antId": 1, "count": 1}],
		)
		self.assertTrue(res.get("ok"))
		self.assertFalse(frappe.db.get_value("RFID Zebra Tag", epc, "purchase_receipt"))

	def test_ingest_tags_duplicate_has_no_side_effects(self) -> None:
		item_code = "_RFID ANT DUP"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = f"{self.EPC_PREFIX}000000000003"
		self._create_tag(epc=epc, item_code=item_code, uom=uom, status="Printed", printed=True)

		api._insert_edge_event(
			event_id="evt-ant-dup",
			device_id=self.device_id,
			batch_id=self.batch_id,
			seq=1,
			event_type="ingest_tags",
			payload={"device": self.device_id, "batch_id": self.batch_id, "seq": 1, "tags": []},
		)

		saved_before = frappe.db.count("RFID Saved Tag", {"epc": epc})
		with patch("frappe.publish_realtime") as publish, patch.object(
			zebra_items, "process_tag_reads"
		) as zebra_process:
			res = api.ingest_tags(
				device=self.device_id,
				event_id="evt-ant-dup",
				batch_id=self.batch_id,
				seq=1,
				tags=[{"epcId": epc, "antId": 1, "count": 1}],
			)
			publish.assert_not_called()
			zebra_process.assert_not_called()

		self.assertTrue(res.get("duplicate"))
		saved_after = frappe.db.count("RFID Saved Tag", {"epc": epc})
		self.assertEqual(saved_before, saved_after)
		self.assertFalse(frappe.db.get_value("RFID Zebra Tag", epc, "purchase_receipt"))

	def test_ingest_tags_scan_recon_blocks(self) -> None:
		item_code = "_RFID ANT SCANREQ"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = f"{self.EPC_PREFIX}000000000004"
		self._create_tag(
			epc=epc,
			item_code=item_code,
			uom=uom,
			status="Printed",
			printed=True,
			scan_recon_required=1,
		)

		res = api.ingest_tags(
			device=self.device_id,
			event_id="evt-ant-2",
			batch_id=self.batch_id,
			seq=2,
			tags=[{"epcId": epc, "antId": 1, "count": 1}],
		)
		self.assertTrue(res.get("ok"))
		self.assertFalse(frappe.db.get_value("RFID Zebra Tag", epc, "purchase_receipt"))

	def test_ingest_tags_after_print_creates_once(self) -> None:
		item_code = "_RFID ANT PRINTED"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = f"{self.EPC_PREFIX}000000000005"
		self._create_tag(epc=epc, item_code=item_code, uom=uom, status="Printed", printed=True)

		res1 = api.ingest_tags(
			device=self.device_id,
			event_id="evt-ant-3",
			batch_id=self.batch_id,
			seq=3,
			tags=[{"epcId": epc, "antId": 1, "count": 1}],
		)
		self.assertTrue(res1.get("ok"))
		se_name = frappe.db.get_value("RFID Zebra Tag", epc, "purchase_receipt")
		self.assertTrue(se_name)
		self.assertEqual(frappe.db.count("Stock Entry", {"name": se_name}), 1)
		tag = frappe.get_doc("RFID Zebra Tag", epc)
		self.assertEqual(tag.last_event_id, "evt-ant-3")
		self.assertEqual(tag.last_batch_id, self.batch_id)
		self.assertEqual(int(tag.last_seq or 0), 3)
		self.assertEqual(tag.last_device_id, self.device_id)
		remarks = frappe.db.get_value("Stock Entry", se_name, "remarks") or ""
		self.assertIn("EVENT=evt-ant-3", remarks)
		self.assertIn(f"BATCH={self.batch_id}", remarks)
		self.assertIn("SEQ=3", remarks)

		res2 = api.ingest_tags(
			device=self.device_id,
			event_id="evt-ant-3",
			batch_id=self.batch_id,
			seq=3,
			tags=[{"epcId": epc, "antId": 1, "count": 1}],
		)
		self.assertTrue(res2.get("duplicate"))
		self.assertEqual(frappe.db.count("Stock Entry", {"name": se_name}), 1)

	def test_upsert_antenna_rule_case_insensitive(self) -> None:
		frappe.db.delete("RFID Antenna Rule", {"device": ["in", ["case-device", "Case-Device"]]})

		res1 = api.upsert_antenna_rule(
			device="Case-Device",
			antenna_id=3,
			submit_stock_entry=1,
			create_delivery_note=0,
			submit_delivery_note=0,
		)
		self.assertTrue(res1.get("ok"))

		res2 = api.upsert_antenna_rule(
			device="case-device",
			antenna_id=3,
			submit_stock_entry=0,
			create_delivery_note=0,
			submit_delivery_note=0,
		)
		self.assertTrue(res2.get("ok"))

		rows = frappe.get_all(
			"RFID Antenna Rule",
			filters={"antenna_id": 3, "device": "case-device"},
			fields=["name", "device"],
		)
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0].get("device"), "case-device")

	def test_ingest_tags_dedup_device_key_uses_device_id(self) -> None:
		if not api._dedup_by_ant_enabled():
			self.skipTest("dedup disabled")

		device = "DEV 1"
		epc = f"{self.EPC_PREFIX}000000000006"
		ant_id = 1
		expected_key = f"{api.SEEN_PREFIX}{api._normalize_device_id(device) or device}:{ant_id}:{epc}"
		sanitized_key = f"{api.SEEN_PREFIX}{api._sanitize_agent_id(device) or device}:{ant_id}:{epc}"

		cache = frappe.cache()
		cache.delete_value(expected_key)
		cache.delete_value(sanitized_key)

		api.ingest_tags(device=device, tags=[{"epcId": epc, "antId": ant_id, "count": 1}])

		self.assertTrue(cache.get_value(expected_key, expires=True))
		self.assertFalse(cache.get_value(sanitized_key, expires=True))

	def test_normalize_device_id_contract(self) -> None:
		self.assertEqual(api._normalize_device_id(" DEV 1 "), "DEV 1")
		self.assertEqual(api._normalize_device_id("DEVICE-XYZ"), "DEVICE-XYZ")
		self.assertEqual(api._normalize_device_id(""), "")
		self.assertEqual(api._normalize_device_id(None), "")
		self.assertEqual(api._normalize_device_id("A" * 80), "A" * 64)
		self.assertEqual(api._normalize_device_id("Девайс"), "Девайс")

	def test_ingest_tags_seq_regression(self) -> None:
		api.edge_event_report(
			event_id="evt-ant-seq-1",
			device_id=self.device_id,
			batch_id=self.batch_id,
			seq=5,
			event_type="ingest_tags",
			payload={},
		)

		frappe.local.response = frappe._dict()
		res = api.ingest_tags(
			device=self.device_id,
			event_id="evt-ant-seq-2",
			batch_id=self.batch_id,
			seq=4,
			tags=[{"epcId": f"{self.EPC_PREFIX}000000000007", "antId": 1, "count": 1}],
		)
		self.assertFalse(res.get("ok"))
		self.assertEqual(res.get("code"), "SEQ_REGRESSION")
		self.assertEqual(frappe.local.response.get("http_status_code"), 409)

	def test_duplicate_antenna_rule_rejected(self) -> None:
		frappe.get_doc(
			{
				"doctype": "RFID Antenna Rule",
				"device": "dup-device",
				"antenna_id": 2,
				"submit_stock_entry": 1,
				"create_delivery_note": 0,
				"submit_delivery_note": 0,
			}
		).insert(ignore_permissions=True)

		with self.assertRaises(frappe.ValidationError):
			frappe.get_doc(
				{
					"doctype": "RFID Antenna Rule",
					"device": "Dup-Device",
					"antenna_id": 2,
					"submit_stock_entry": 1,
					"create_delivery_note": 0,
					"submit_delivery_note": 0,
				}
			).insert(ignore_permissions=True)
