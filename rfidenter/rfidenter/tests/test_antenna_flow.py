from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase
from erpnext.stock.doctype.item.test_item import create_item

from rfidenter.rfidenter import api


class TestAntennaFlow(FrappeTestCase):
	def setUp(self) -> None:
		frappe.set_user("Administrator")
		self.device_id = "ant-device-test"
		self.batch_id = "ant-batch-test"
		frappe.db.delete("RFID Edge Event", {"device_id": self.device_id})
		frappe.db.delete("RFID Batch State", {"device_id": self.device_id})
		frappe.db.delete("RFID Zebra Tag", {"epc": ["like", "EPC-ANT-%"]})
		frappe.db.delete("RFID Antenna Rule", {"device": self.device_id})

	def _ensure_master_data(self, item_code: str) -> str:
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
		epc = "EPC-ANT-NOEVT"
		self._create_tag(epc=epc, item_code=item_code, uom=uom, status="Printed", printed=True)

		res = api.ingest_tags(device=self.device_id, tags=[{"epcId": epc, "antId": 1, "count": 1}])
		self.assertTrue(res.get("ok"))
		self.assertFalse(frappe.db.get_value("RFID Zebra Tag", epc, "purchase_receipt"))

	def test_ingest_tags_requires_print_complete(self) -> None:
		item_code = "_RFID ANT NOTPRINTED"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = "EPC-ANT-NOPRINT"
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

	def test_ingest_tags_scan_recon_blocks(self) -> None:
		item_code = "_RFID ANT SCANREQ"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = "EPC-ANT-SCANREQ"
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
		epc = "EPC-ANT-PRINTED"
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

		res2 = api.ingest_tags(
			device=self.device_id,
			event_id="evt-ant-3",
			batch_id=self.batch_id,
			seq=3,
			tags=[{"epcId": epc, "antId": 1, "count": 1}],
		)
		self.assertTrue(res2.get("duplicate"))
		self.assertEqual(frappe.db.count("Stock Entry", {"name": se_name}), 1)

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
			tags=[{"epcId": "EPC-ANT-SEQ", "antId": 1, "count": 1}],
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
