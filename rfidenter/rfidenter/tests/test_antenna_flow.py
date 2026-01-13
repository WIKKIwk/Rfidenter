from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from erpnext.stock.doctype.item.test_item import create_item

from rfidenter.rfidenter import api


class TestAntennaFlow(FrappeTestCase):
	TEST_PREFIX = "_RFIDTST"
	EPC_PREFIX = "E2ABAA"

	def setUp(self) -> None:
		frappe.set_user("Administrator")
		self._ensure_company()
		self._ensure_warehouse()
		self._ensure_supplier()
		self._ensure_customer()
		self.device_id = f"{self.TEST_PREFIX}-device"
		self.batch_id = f"{self.TEST_PREFIX}-batch"

		frappe.db.delete("RFID Edge Event", {"event_id": ["like", "evt-ant-%"]})
		frappe.db.delete("RFID Edge Event", {"device_id": self.device_id})
		frappe.db.delete("RFID Batch State", {"device_id": self.device_id})
		frappe.db.delete("RFID Zebra Tag", {"epc": ["like", f"{self.EPC_PREFIX}%"]})
		frappe.db.delete("RFID Zebra Dedupe", {"raw_key": ["like", "evt-ant-%:%"]})
		frappe.db.delete("RFID Saved Tag", {"epc": ["like", f"{self.EPC_PREFIX}%"]})
		frappe.db.delete("RFID Antenna Rule", {"device": self.device_id})

	def _ensure_company(self) -> None:
		company_name = f"{self.TEST_PREFIX} Company"
		company = None
		if frappe.db.exists("Company", company_name):
			company = frappe.get_doc("Company", company_name)
		else:
			company = frappe.get_doc(
				{
					"doctype": "Company",
					"company_name": company_name,
					"abbr": "RFT",
					"country": "India",
					"default_currency": "INR",
					"create_chart_of_accounts_based_on": "Standard Template",
					"chart_of_accounts": "Standard",
				}
			)
			company = company.save()

		if not frappe.db.exists("Account", {"company": company.name}):
			try:
				company.create_default_accounts()
			except Exception:
				pass

		if not frappe.db.exists("Warehouse", {"company": company.name}):
			try:
				company.create_default_warehouses()
			except Exception:
				pass

		if not company.stock_adjustment_account:
			stock_adj = frappe.db.get_value(
				"Account", {"company": company.name, "account_type": "Stock Adjustment", "is_group": 0}, "name"
			)
			if not stock_adj:
				stock_adj = frappe.db.get_value(
					"Account", {"company": company.name, "root_type": "Expense", "is_group": 0}, "name"
				)
			if stock_adj:
				company.db_set("stock_adjustment_account", stock_adj)

		if not company.cost_center:
			cost_center = frappe.db.get_value(
				"Cost Center", {"company": company.name, "is_group": 0}, "name"
			)
			if cost_center:
				company.db_set("cost_center", cost_center)

		self.company = company.name
		self.company_abbr = company.abbr or "RFT"

	def _ensure_warehouse(self) -> None:
		root = frappe.db.get_value("Warehouse", {"company": self.company, "is_group": 1}, "name")
		if not root:
			root = (
				frappe.get_doc(
					{
						"doctype": "Warehouse",
						"warehouse_name": "All Warehouses",
						"is_group": 1,
						"company": self.company,
					}
				)
				.insert(ignore_permissions=True)
				.name
			)

		wh_name = f"RFID Warehouse - {self.company_abbr}"
		if not frappe.db.exists("Warehouse", wh_name):
			frappe.get_doc(
				{
					"doctype": "Warehouse",
					"warehouse_name": "RFID Warehouse",
					"parent_warehouse": root,
					"is_group": 0,
					"company": self.company,
				}
			).insert(ignore_permissions=True)
		self.warehouse = wh_name

	def _ensure_supplier(self) -> None:
		name = f"{self.TEST_PREFIX} Supplier"
		if not frappe.db.exists("Supplier", name):
			frappe.get_doc(
				{
					"doctype": "Supplier",
					"supplier_name": name,
					"supplier_type": "Individual",
					"supplier_group": "Local",
				}
			).insert(ignore_permissions=True)
		self.supplier = name

	def _ensure_customer(self) -> None:
		name = f"{self.TEST_PREFIX} Customer"
		if not frappe.db.exists("Customer", name):
			frappe.get_doc(
				{
					"doctype": "Customer",
					"customer_name": name,
					"type": "Individual",
				}
			).insert(ignore_permissions=True)
		self.customer = name

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
		item_code = f"{self.TEST_PREFIX}-NOEVENT"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = f"{self.EPC_PREFIX}000000000001"
		self._create_tag(epc=epc, item_code=item_code, uom=uom, status="Printed", printed=True)

		res = api.ingest_tags(device=self.device_id, tags=[{"epcId": epc, "antId": 1, "count": 1}])
		self.assertTrue(res.get("ok"))
		self.assertFalse(frappe.db.get_value("RFID Zebra Tag", epc, "purchase_receipt"))

	def test_ingest_tags_requires_print_complete(self) -> None:
		item_code = f"{self.TEST_PREFIX}-NOPRINT"
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
		item_code = f"{self.TEST_PREFIX}-DUP"
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

		state = frappe.get_doc(
			{
				"doctype": "RFID Batch State",
				"device_id": self.device_id,
				"status": "Running",
				"last_event_seq": 1,
				"last_seen_at": frappe.utils.now_datetime(),
			}
		)
		state.insert(ignore_permissions=True)

		edge_before = frappe.db.count("RFID Edge Event", {"device_id": self.device_id})
		state_before = frappe.db.get_value(
			"RFID Batch State",
			{"device_id": self.device_id},
			["last_seen_at", "modified"],
			as_dict=True,
		)
		saved_before = frappe.db.count("RFID Saved Tag", {"epc": epc})
		purchase_before = frappe.db.get_value("RFID Zebra Tag", epc, "purchase_receipt")

		with patch("frappe.publish_realtime") as publish:
			res = api.ingest_tags(
				device=self.device_id,
				event_id="evt-ant-dup",
				batch_id=self.batch_id,
				seq=1,
				tags=[{"epcId": epc, "antId": 1, "count": 1}],
			)
			publish.assert_not_called()

		self.assertTrue(res.get("duplicate"))
		edge_after = frappe.db.count("RFID Edge Event", {"device_id": self.device_id})
		state_after = frappe.db.get_value(
			"RFID Batch State",
			{"device_id": self.device_id},
			["last_seen_at", "modified"],
			as_dict=True,
		)
		saved_after = frappe.db.count("RFID Saved Tag", {"epc": epc})
		purchase_after = frappe.db.get_value("RFID Zebra Tag", epc, "purchase_receipt")

		self.assertEqual(edge_before, edge_after)
		self.assertEqual(state_before.get("last_seen_at"), state_after.get("last_seen_at"))
		self.assertEqual(state_before.get("modified"), state_after.get("modified"))
		self.assertEqual(saved_before, saved_after)
		self.assertEqual(purchase_before, purchase_after)

	def test_ingest_tags_scan_recon_blocks(self) -> None:
		item_code = f"{self.TEST_PREFIX}-SCANREQ"
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
		item_code = f"{self.TEST_PREFIX}-PRINTED"
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
		self.assertEqual(api._normalize_device_id(""), "")
		self.assertEqual(api._normalize_device_id(None), "")
		self.assertEqual(len(api._normalize_device_id("A" * 80)), 64)

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
