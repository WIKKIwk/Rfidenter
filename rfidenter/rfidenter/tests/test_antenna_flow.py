from __future__ import annotations

import datetime
import json
import re
import secrets
from unittest.mock import patch

import frappe
from erpnext.stock.doctype.item.test_item import create_item
from frappe.tests.utils import FrappeTestCase

from rfidenter.rfidenter import api


class TestAntennaFlow(FrappeTestCase):
	TEST_PREFIX = "_RFIDTST"
	EVENT_PREFIX = ""
	EPC_PREFIX = ""
	COMPANY_NAME = ""
	COMPANY_ABBR = ""
	DEVICE_ID = ""
	BATCH_ID = ""
	_FROZEN_TIME: tuple[datetime.datetime, int, str] | None = None

	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		suffix = frappe.generate_hash(length=6)
		cls.TEST_PREFIX = f"_RFIDTST_{suffix}"
		cls.EVENT_PREFIX = f"evt-{cls.TEST_PREFIX}-"
		cls.EPC_PREFIX = secrets.token_hex(3).upper()
		cls.COMPANY_ABBR = cls._allocate_company_abbr()
		cls.COMPANY_NAME = f"{cls.TEST_PREFIX} Company"
		cls.DEVICE_ID = f"{cls.TEST_PREFIX}-device"
		cls.BATCH_ID = f"{cls.TEST_PREFIX}-batch"

	@classmethod
	def _allocate_company_abbr(cls) -> str:
		for _ in range(20):
			abbr = f"R{secrets.token_hex(2).upper()}"
			if not frappe.db.exists("Company", {"abbr": abbr}):
				return abbr
		raise AssertionError("Could not allocate unique company abbreviation.")

	def setUp(self) -> None:
		frappe.set_user("Administrator")

		# Tests must not depend on external site config toggles.
		# rfidenter reads config from frappe.conf (site_config.json is best-effort in api.py).
		self._set_conf("rfidenter_dedup_by_ant", True)
		self._set_conf("rfidenter_antenna_ttl_sec", 24 * 3600)
		self.assertTrue(api._dedup_by_ant_enabled(), "rfidenter_dedup_by_ant must be enabled for this suite")

		# Freeze all "now" calls used by ERPNext/Frappe in this module to a single deterministic moment.
		# This prevents midnight/timezone flakes while still staying within the site's current fiscal year window.
		aware_local, _, _ = self._midday_local_ts_and_day()
		assert aware_local.tzinfo is not None, "midday local must be timezone-aware"
		fixed_now_local_naive = aware_local.replace(tzinfo=None)
		assert fixed_now_local_naive.tzinfo is None, "Frappe now_datetime must be naive system-timezone"
		self._now_ticks = 0

		def _tick_now_datetime() -> datetime.datetime:
			# Frappe compares modified timestamps with microsecond precision. A constant now_datetime()
			# causes TimestampMismatchError across versions. This tick keeps a deterministic monotonic clock.
			self._now_ticks += 1
			return fixed_now_local_naive + datetime.timedelta(microseconds=self._now_ticks)

		for patcher in (
			patch("frappe.utils.now_datetime", side_effect=_tick_now_datetime),
			patch("frappe.utils.data.now_datetime", side_effect=_tick_now_datetime),
			patch("frappe.utils.nowdate", return_value=fixed_now_local_naive.date().isoformat()),
			patch("frappe.utils.data.nowdate", return_value=fixed_now_local_naive.date().isoformat()),
			patch("frappe.utils.today", return_value=fixed_now_local_naive.date().isoformat()),
			patch("frappe.utils.data.today", return_value=fixed_now_local_naive.date().isoformat()),
		):
			patcher.start()
			self.addCleanup(patcher.stop)

		self._ensure_company()
		self._ensure_accounts()
		self._ensure_cost_centers()
		self._ensure_warehouse()
		self._ensure_supplier()
		self._ensure_customer()
		self.device_id = self.DEVICE_ID
		self.batch_id = self.BATCH_ID
		self._cleanup_test_data()

	def _set_conf(self, key: str, value: object) -> None:
		prev = frappe.conf.get(key) if hasattr(frappe, "conf") else None
		frappe.conf[key] = value

		def _restore() -> None:
			if prev is None:
				try:
					frappe.conf.pop(key, None)
				except Exception:
					pass
			else:
				frappe.conf[key] = prev

		self.addCleanup(_restore)

	def _cleanup_test_data(self) -> None:
		event_like = f"{self.EVENT_PREFIX}%"
		epc_like = f"{self.EPC_PREFIX}%"
		frappe.db.delete("RFID Edge Event", {"event_id": ["like", event_like]})
		frappe.db.delete("RFID Edge Event", {"device_id": self.device_id})
		frappe.db.delete("RFID Batch State", {"device_id": self.device_id})
		frappe.db.delete("RFID Zebra Tag", {"epc": ["like", epc_like]})
		frappe.db.delete("RFID Zebra Dedupe", {"idempotency_key": ["like", f"%{self.EVENT_PREFIX}%"]})
		frappe.db.delete("RFID Saved Tag", {"epc": ["like", epc_like]})
		frappe.db.delete("RFID Saved Tag Day", {"epc": ["like", epc_like]})
		frappe.db.delete("RFID Antenna Rule", {"device": ["like", f"%{self.TEST_PREFIX}%"]})
		frappe.db.delete("RFID Zebra Item Receipt Setting", {"item_code": ["like", f"{self.TEST_PREFIX}%"]})
		frappe.db.delete("RFID Delivery Note Setting", {"item_code": ["like", f"{self.TEST_PREFIX}%"]})

	def _midday_local_ts_and_day(self) -> tuple[datetime.datetime, int, str]:
		"""
		Return (aware_dt_local, ts_epoch_ms, day_iso) for a deterministic “midday today” moment.

		- All conversions start from an aware UTC datetime to avoid naive-datetime astimezone crashes.
		- `day_iso` is derived from `ts_epoch_ms` via the same tz conversion path, so they cannot diverge.

		We prefer Frappe’s pytz-based utilities (works even when system tzdata/ZoneInfo is missing).
		If unavailable, we fall back to ZoneInfo; if that fails too, we fall back to UTC.
		"""

		def _system_tz_name() -> str:
			tz = ""
			try:
				from frappe.utils.data import get_system_timezone  # type: ignore

				tz = str(get_system_timezone() or "")
			except Exception:
				tz = ""
			if not tz:
				try:
					tz = str(frappe.get_system_settings("time_zone") or "")
				except Exception:
					tz = ""
			# Match frappe.utils.data.get_system_timezone default (Asia/Kolkata) when unset.
			return tz.strip() or "Asia/Kolkata"

		# Cached for the whole test run to avoid flakiness if the suite crosses midnight.
		cached = getattr(self.__class__, "_FROZEN_TIME", None)
		if cached:
			return cached

		tz_name = _system_tz_name()

		def _utc_to_local(utc_dt: datetime.datetime) -> datetime.datetime:
			assert utc_dt.tzinfo is not None, "utc_dt must be timezone-aware"
			try:
				from frappe.utils.data import convert_utc_to_timezone  # type: ignore

				return convert_utc_to_timezone(utc_dt, tz_name)
			except Exception:
				pass
			try:
				from zoneinfo import ZoneInfo

				return utc_dt.astimezone(ZoneInfo(tz_name))
			except Exception:
				# Last resort: treat as UTC (keeps ts/day consistent even if tzdata is missing).
				return utc_dt

		utc_now = datetime.datetime.now(datetime.timezone.utc)
		local_now = _utc_to_local(utc_now)
		local_day = local_now.date()
		naive_midday = datetime.datetime(local_day.year, local_day.month, local_day.day, 12, 0, 0)

		# Build an aware local-midday datetime.
		aware_midday_local: datetime.datetime | None = None
		try:
			import pytz

			try:
				tz = pytz.timezone(tz_name)
				aware_midday_local = tz.localize(naive_midday)
			except Exception:
				aware_midday_local = None
		except Exception:
			aware_midday_local = None

		if aware_midday_local is None:
			try:
				from zoneinfo import ZoneInfo

				aware_midday_local = naive_midday.replace(tzinfo=ZoneInfo(tz_name))
			except Exception:
				# No tzdata available: UTC fallback.
				aware_midday_local = naive_midday.replace(tzinfo=datetime.timezone.utc)

		# ingest_tags `ts` unit contract is asserted in `test_ingest_tags_after_print_creates_once`.
		# Use epoch-milliseconds here because rfidenter antenna stats (`last_seen`) is ms-based.
		ts_epoch = int(aware_midday_local.astimezone(datetime.timezone.utc).timestamp() * 1000)

		# Derive day from ts_epoch via the SAME conversion path used for `local_now`.
		# This round-trip guarantees day cannot diverge from ts_epoch.
		utc_from_ts = datetime.datetime.fromtimestamp(ts_epoch / 1000, tz=datetime.timezone.utc)
		local_from_ts = _utc_to_local(utc_from_ts)
		assert local_from_ts.tzinfo is not None, "local_from_ts must be timezone-aware"
		day = local_from_ts.date().isoformat()

		frozen = (local_from_ts, ts_epoch, day)
		self.__class__._FROZEN_TIME = frozen
		return frozen

	def _saved_tag_bucket_day_iso(self) -> str:
		# Production bucketing for RFID Saved Tag Day is `frappe.utils.now_datetime().date().isoformat()`.
		# We call the same function here (patched deterministically in setUp).
		return frappe.utils.now_datetime().date().isoformat()

	def _safe_select_option(self, doctype: str, fieldname: str, preferred: str) -> str:
		meta = frappe.get_meta(doctype)
		field = meta.get_field(fieldname)
		raw = str(getattr(field, "options", "") or "")

		def _is_placeholder(option: str) -> bool:
			opt = str(option or "").strip()
			if not opt:
				return True

			if re.fullmatch(r"-+", opt):
				return True

			core = re.sub(r"^[\s\-_]+|[\s\-_]+$", "", opt, flags=re.IGNORECASE).strip()
			if not core:
				return True

			lower = core.lower()
			if lower in {"none", "null"}:
				return True

			# Word-boundary based placeholders: do NOT match "selection/selected/selective".
			if re.fullmatch(r"select", lower, flags=re.IGNORECASE):
				return True
			if re.fullmatch(r"please\s+select", lower, flags=re.IGNORECASE):
				return True
			if re.fullmatch(r"select(\s+an)?\s+option", lower, flags=re.IGNORECASE):
				return True
			if re.fullmatch(r"choose(\s+an)?\s+option", lower, flags=re.IGNORECASE):
				return True

			return False

		valid: list[str] = []
		for option in raw.splitlines():
			opt = option.strip()
			if _is_placeholder(opt):
				continue
			valid.append(opt)

		preferred_norm = str(preferred or "").strip()
		if preferred_norm:
			for opt in valid:
				if opt.lower() == preferred_norm.lower():
					return opt

		if valid:
			return valid[0]

		raise AssertionError(f"Missing non-placeholder options for {doctype}.{fieldname}")

	def _ensure_currency(self, code: str) -> str:
		if frappe.db.exists("Currency", code):
			return code
		try:
			frappe.get_doc({"doctype": "Currency", "currency_name": code, "enabled": 1}).insert(ignore_permissions=True)
		except Exception as exc:
			raise AssertionError(f"Currency creation failed: {exc}") from exc
		return code

	def _ensure_country(self, name: str) -> str:
		if frappe.db.exists("Country", name):
			return name
		try:
			frappe.get_doc({"doctype": "Country", "country_name": name}).insert(ignore_permissions=True)
		except Exception as exc:
			raise AssertionError(f"Country creation failed: {exc}") from exc
		return name

	def _ensure_company(self) -> None:
		if frappe.db.exists("Company", self.COMPANY_NAME):
			company = frappe.get_doc("Company", self.COMPANY_NAME)
		else:
			currency = self._ensure_currency("USD")
			country = self._ensure_country("India")
			values = {
				"doctype": "Company",
				"company_name": self.COMPANY_NAME,
				"abbr": self.COMPANY_ABBR,
				"default_currency": currency,
				"country": country,
			}
			company_meta = frappe.get_meta("Company")
			if company_meta.get_field("create_chart_of_accounts_based_on"):
				values["create_chart_of_accounts_based_on"] = self._safe_select_option(
					"Company",
					"create_chart_of_accounts_based_on",
					"Standard Template",
				)
			if company_meta.get_field("chart_of_accounts"):
				values["chart_of_accounts"] = "Standard"
			for field in company_meta.fields:
				if not getattr(field, "reqd", 0):
					continue
				if field.fieldname in values and values[field.fieldname]:
					continue
				if field.fieldtype == "Check":
					values[field.fieldname] = 0
				elif field.fieldtype == "Data":
					values[field.fieldname] = f"{self.TEST_PREFIX} {field.fieldname}"
				elif field.fieldtype == "Select":
					values[field.fieldname] = self._safe_select_option("Company", field.fieldname, "")
				else:
					raise AssertionError(f"Unsupported required Company field: {field.fieldname} ({field.fieldtype})")
			company = frappe.get_doc(values)
			try:
				company.insert(ignore_permissions=True)
			except Exception as exc:
				raise AssertionError(f"Company creation failed: {exc}") from exc

		if frappe.get_meta("Company").get_field("chart_of_accounts") and not (company.get("chart_of_accounts") or ""):
			company.db_set("chart_of_accounts", "Standard", update_modified=False)
			company.reload()

		if not frappe.db.exists("Account", {"company": company.name}):
			try:
				company.create_default_accounts()
			except Exception as exc:
				raise AssertionError(f"Default accounts creation failed: {exc}") from exc

		self.company = company.name
		self.company_abbr = company.abbr
		self.company_doc = company

	def _ensure_accounts(self) -> None:
		company = frappe.get_doc("Company", self.company)

		attempted_default_accounts = False

		def _get_root_parent(root_type: str) -> str | None:
			return frappe.db.get_value(
				"Account",
				{"company": self.company, "root_type": root_type, "is_group": 1},
				"name",
				order_by="lft asc",
			)

		def _try_default_accounts() -> None:
			nonlocal attempted_default_accounts
			if attempted_default_accounts:
				return
			attempted_default_accounts = True
			try:
				company.create_default_accounts()
			except Exception:
				pass

		def _ensure_min_root_account(*, root_type: str, report_type: str, account_name: str) -> str:
			existing = frappe.db.get_value(
				"Account",
				{"company": self.company, "account_name": account_name, "is_group": 1},
				"name",
			)
			if existing:
				return existing
			doc = frappe.get_doc(
				{
					"doctype": "Account",
					"account_name": account_name,
					"is_group": 1,
					"root_type": root_type,
					"report_type": report_type,
					"company": self.company,
				}
			)
			try:
				doc.insert()
			except (frappe.PermissionError, frappe.ValidationError):
				try:
					doc.insert(ignore_permissions=True)
				except Exception as exc:
					raise AssertionError(f"Minimal root account creation failed ({root_type}): {exc}") from exc
			except Exception as exc:
				raise AssertionError(f"Minimal root account creation failed ({root_type}): {exc}") from exc
			return doc.name

		expense_parent = _get_root_parent("Expense")
		asset_parent = _get_root_parent("Asset")
		if not expense_parent or not asset_parent:
			_try_default_accounts()
			expense_parent = expense_parent or _get_root_parent("Expense")
			asset_parent = asset_parent or _get_root_parent("Asset")

		if not expense_parent:
			expense_parent = _ensure_min_root_account(
				root_type="Expense",
				report_type="Profit and Loss",
				account_name=f"{self.TEST_PREFIX} Root Expense",
			)
		if not asset_parent:
			asset_parent = _ensure_min_root_account(
				root_type="Asset",
				report_type="Balance Sheet",
				account_name=f"{self.TEST_PREFIX} Root Asset",
			)

		expense_root = frappe.db.get_value(
			"Account",
			{"company": self.company, "account_name": f"{self.TEST_PREFIX} Expenses", "is_group": 1},
			"name",
		)
		if not expense_root:
			expense_root_doc = frappe.get_doc(
				{
					"doctype": "Account",
					"account_name": f"{self.TEST_PREFIX} Expenses",
					"parent_account": expense_parent,
					"is_group": 1,
					"company": self.company,
				}
			)
			try:
				expense_root_doc.insert(ignore_permissions=True)
			except Exception as exc:
				raise AssertionError(f"Expense root account creation failed: {exc}") from exc
			expense_root = expense_root_doc.name

		stock_adj = frappe.db.get_value(
			"Account",
			{"company": self.company, "account_name": f"{self.TEST_PREFIX} Stock Adjustment", "is_group": 0},
			"name",
		)
		if not stock_adj:
			stock_adj_doc = frappe.get_doc(
				{
					"doctype": "Account",
					"account_name": f"{self.TEST_PREFIX} Stock Adjustment",
					"parent_account": expense_root,
					"is_group": 0,
					"account_type": "Stock Adjustment",
					"company": self.company,
				}
			)
			try:
				stock_adj_doc.insert(ignore_permissions=True)
			except Exception as exc:
				raise AssertionError(f"Stock adjustment account creation failed: {exc}") from exc
			stock_adj = stock_adj_doc.name

		asset_root = frappe.db.get_value(
			"Account",
			{"company": self.company, "account_name": f"{self.TEST_PREFIX} Assets", "is_group": 1},
			"name",
		)
		if not asset_root:
			asset_root_doc = frappe.get_doc(
				{
					"doctype": "Account",
					"account_name": f"{self.TEST_PREFIX} Assets",
					"parent_account": asset_parent,
					"is_group": 1,
					"company": self.company,
				}
			)
			try:
				asset_root_doc.insert(ignore_permissions=True)
			except Exception as exc:
				raise AssertionError(f"Asset root account creation failed: {exc}") from exc
			asset_root = asset_root_doc.name

		stock_inventory = frappe.db.get_value(
			"Account",
			{"company": self.company, "account_name": f"{self.TEST_PREFIX} Inventory", "is_group": 0},
			"name",
		)
		if not stock_inventory:
			stock_inventory_doc = frappe.get_doc(
				{
					"doctype": "Account",
					"account_name": f"{self.TEST_PREFIX} Inventory",
					"parent_account": asset_root,
					"is_group": 0,
					"account_type": "Stock",
					"company": self.company,
				}
			)
			try:
				stock_inventory_doc.insert(ignore_permissions=True)
			except Exception as exc:
				raise AssertionError(f"Inventory account creation failed: {exc}") from exc
			stock_inventory = stock_inventory_doc.name

		company.db_set("stock_adjustment_account", stock_adj)
		if frappe.get_meta("Company").get_field("default_inventory_account"):
			company.db_set("default_inventory_account", stock_inventory)

	def _ensure_cost_centers(self) -> None:
		company = frappe.get_doc("Company", self.company)

		root_name = frappe.db.get_value(
			"Cost Center",
			{"company": self.company, "is_group": 1},
			"name",
			order_by="lft asc",
		)
		if not root_name:
			try:
				company.create_default_cost_center()
			except Exception as exc:
				raise AssertionError(f"Default cost center creation failed: {exc}") from exc
			root_name = frappe.db.get_value(
				"Cost Center",
				{"company": self.company, "is_group": 1},
				"name",
				order_by="lft asc",
			)
			if not root_name:
				raise AssertionError("Root cost center missing after create_default_cost_center().")

		leaf_cc_name = f"{self.TEST_PREFIX} Main"
		leaf = frappe.db.get_value(
			"Cost Center",
			{"company": self.company, "cost_center_name": leaf_cc_name, "is_group": 0},
			"name",
		)
		if not leaf:
			leaf_doc = frappe.get_doc(
				{
					"doctype": "Cost Center",
					"cost_center_name": leaf_cc_name,
					"parent_cost_center": root_name,
					"is_group": 0,
					"company": self.company,
				}
			)
			try:
				leaf_doc.insert(ignore_permissions=True)
			except Exception as exc:
				raise AssertionError(f"Leaf cost center creation failed: {exc}") from exc
			leaf = leaf_doc.name

		company.db_set("cost_center", leaf)

	def _ensure_warehouse(self) -> None:
		root_name = f"{self.TEST_PREFIX} Root Warehouse"
		root = frappe.db.get_value(
			"Warehouse",
			{"company": self.company, "warehouse_name": root_name, "is_group": 1},
			"name",
		)
		if not root:
			try:
				root_doc = frappe.get_doc(
					{
						"doctype": "Warehouse",
						"warehouse_name": root_name,
						"is_group": 1,
						"company": self.company,
					}
				).insert(ignore_permissions=True)
				root = root_doc.name
			except Exception as exc:
				raise AssertionError(f"Root warehouse creation failed: {exc}") from exc

		leaf_name = f"{self.TEST_PREFIX} Warehouse"
		leaf = frappe.db.get_value(
			"Warehouse",
			{"company": self.company, "warehouse_name": leaf_name, "is_group": 0},
			"name",
		)
		if not leaf:
			try:
				leaf_doc = frappe.get_doc(
					{
						"doctype": "Warehouse",
						"warehouse_name": leaf_name,
						"parent_warehouse": root,
						"is_group": 0,
						"company": self.company,
					}
				).insert(ignore_permissions=True)
				leaf = leaf_doc.name
			except Exception as exc:
				raise AssertionError(f"Leaf warehouse creation failed: {exc}") from exc

		self.warehouse = leaf

		# Ensure warehouse resolves to an inventory account on a fresh site.
		try:
			company = frappe.get_doc("Company", self.company)
			if company.default_inventory_account:
				frappe.db.set_value("Warehouse", leaf, "account", company.default_inventory_account, update_modified=False)
		except Exception:
			pass

	def _ensure_required_link_group(self, doctype: str, fieldname: str, group_doctype: str, group_field: str) -> str:
		meta = frappe.get_meta(doctype)
		field = meta.get_field(fieldname)
		if not field or not getattr(field, "reqd", 0):
			return ""

		group_meta = frappe.get_meta(group_doctype)
		parent_field = None
		for group_field_meta in group_meta.fields:
			if (
				group_field_meta.fieldtype == "Link"
				and group_field_meta.options == group_doctype
				and str(group_field_meta.fieldname or "").startswith("parent_")
			):
				parent_field = group_field_meta.fieldname
				break

		root_name = f"{self.TEST_PREFIX} {group_doctype} Root"
		if not frappe.db.exists(group_doctype, root_name):
			frappe.get_doc(
				{
					"doctype": group_doctype,
					group_field: root_name,
					"is_group": 1,
				}
			).insert(ignore_permissions=True)

		leaf_name = f"{self.TEST_PREFIX} {group_doctype}"
		if not frappe.db.exists(group_doctype, leaf_name):
			values = {
				"doctype": group_doctype,
				group_field: leaf_name,
				"is_group": 0,
			}
			if parent_field:
				values[parent_field] = root_name
			frappe.get_doc(values).insert(ignore_permissions=True)
		return leaf_name

	def _ensure_supplier(self) -> None:
		name = f"{self.TEST_PREFIX} Supplier"
		if not frappe.db.exists("Supplier", name):
			supplier_type = self._safe_select_option("Supplier", "supplier_type", "Company")
			supplier_group = self._ensure_required_link_group("Supplier", "supplier_group", "Supplier Group", "supplier_group_name")
			try:
				values = {"doctype": "Supplier", "supplier_name": name, "supplier_type": supplier_type}
				if supplier_group:
					values["supplier_group"] = supplier_group
				frappe.get_doc(values).insert(ignore_permissions=True)
			except Exception as exc:
				raise AssertionError(f"Supplier creation failed: {exc}") from exc
		self.supplier = name

	def _ensure_customer(self) -> None:
		name = f"{self.TEST_PREFIX} Customer"
		if not frappe.db.exists("Customer", name):
			customer_type = self._safe_select_option("Customer", "customer_type", "Company")
			customer_group = self._ensure_required_link_group("Customer", "customer_group", "Customer Group", "customer_group_name")
			try:
				values = {"doctype": "Customer", "customer_name": name, "customer_type": customer_type}
				if customer_group:
					values["customer_group"] = customer_group
				frappe.get_doc(values).insert(ignore_permissions=True)
			except Exception as exc:
				raise AssertionError(f"Customer creation failed: {exc}") from exc
		self.customer = name

	def _ensure_item_group(self) -> None:
		if not frappe.db.exists("Item Group", "All Item Groups"):
			try:
				frappe.get_doc(
					{"doctype": "Item Group", "item_group_name": "All Item Groups", "is_group": 1}
				).insert(ignore_permissions=True)
			except Exception as exc:
				raise AssertionError(f"Item Group creation failed: {exc}") from exc

	def _ensure_uom(self, uom: str) -> None:
		if not frappe.db.exists("UOM", uom):
			try:
				frappe.get_doc({"doctype": "UOM", "uom_name": uom, "enabled": 1}).insert(ignore_permissions=True)
			except Exception as exc:
				raise AssertionError(f"UOM creation failed: {exc}") from exc

	def _ensure_master_data(self, item_code: str) -> str:
		self._ensure_item_group()
		self._ensure_uom("Nos")
		item = create_item(item_code, is_stock_item=1, stock_uom="Nos", warehouse=self.warehouse, company=self.company)
		uom = item.stock_uom
		if not uom:
			raise AssertionError("Item stock_uom missing for test item.")

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

	def _new_event_id(self) -> str:
		return f"{self.EVENT_PREFIX}{frappe.generate_hash(length=12)}"

	def _new_epc(self, i: int) -> str:
		# Stable valid-hex EPC (<=128 chars) unique within the test class.
		return f"{self.EPC_PREFIX}{i:06X}{secrets.token_hex(6).upper()}"

	def _resolve_receipt_doctype(self, name: str) -> str:
		if frappe.db.exists("Stock Entry", name):
			return "Stock Entry"
		if frappe.db.exists("Purchase Receipt", name):
			return "Purchase Receipt"
		raise AssertionError(f"purchase_receipt doc not found: {name}")

	def _count_tag_docs(self, fieldname: str) -> int:
		names = frappe.db.get_all(
			"RFID Zebra Tag",
			filters={"epc": ["like", f"{self.EPC_PREFIX}%"], fieldname: ["!=", ""]},
			pluck=fieldname,
		)
		return len({name for name in names if name})

	def _snapshot_row(self, doctype: str, filters: dict[str, object], fields: list[str]) -> dict[str, object] | None:
		row = frappe.db.get_value(doctype, filters, fields, as_dict=True)
		if not row:
			return None
		return {field: row.get(field) for field in fields}

	def test_ingest_tags_without_event_id_no_stock_entry(self) -> None:
		item_code = f"{self.TEST_PREFIX}-NOEVENT"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = self._new_epc(1)
		self._create_tag(epc=epc, item_code=item_code, uom=uom, status="Printed", printed=True)

		_, ts_epoch, _ = self._midday_local_ts_and_day()
		res = api.ingest_tags(device=self.device_id, ts=ts_epoch, tags=[{"epcId": epc, "antId": 1, "count": 1}])
		self.assertTrue(res.get("ok"))
		self.assertFalse(frappe.db.get_value("RFID Zebra Tag", {"epc": epc}, "purchase_receipt"))

	def test_ingest_tags_requires_print_complete(self) -> None:
		item_code = f"{self.TEST_PREFIX}-NOPRINT"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = self._new_epc(2)
		self._create_tag(epc=epc, item_code=item_code, uom=uom, status="Pending Print", printed=False)

		event_id = self._new_event_id()
		_, ts_epoch, _ = self._midday_local_ts_and_day()
		res = api.ingest_tags(
			device=self.device_id,
			event_id=event_id,
			batch_id=self.batch_id,
			seq=1,
			ts=ts_epoch,
			tags=[{"epcId": epc, "antId": 1, "count": 1}],
		)
		self.assertTrue(res.get("ok"))
		self.assertFalse(frappe.db.get_value("RFID Zebra Tag", {"epc": epc}, "purchase_receipt"))

	def test_ingest_tags_duplicate_has_no_side_effects(self) -> None:
		item_code = f"{self.TEST_PREFIX}-DUP"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = self._new_epc(3)
		self._create_tag(epc=epc, item_code=item_code, uom=uom, status="Printed", printed=True)

		event_id = self._new_event_id()
		api._insert_edge_event(
			event_id=event_id,
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

		_, ts_epoch, _ = self._midday_local_ts_and_day()
		day = self._saved_tag_bucket_day_iso()

		edge_before_device = frappe.db.count("RFID Edge Event", {"device_id": self.device_id})
		edge_before_event = frappe.db.count("RFID Edge Event", {"event_id": event_id})

		state_fields = ["status", "last_event_seq", "last_seen_at", "modified"]
		state_before = self._snapshot_row("RFID Batch State", {"device_id": self.device_id}, state_fields)

		saved_fields = ["reads", "last_seen", "device", "modified"]
		saved_before = self._snapshot_row("RFID Saved Tag", {"epc": epc}, saved_fields)
		saved_day_before = self._snapshot_row("RFID Saved Tag Day", {"epc": epc, "day": day}, saved_fields)

		dedupe_before = frappe.db.count("RFID Zebra Dedupe", {"idempotency_key": ["like", f"%{event_id}%"]})
		stock_before = self._count_tag_docs("purchase_receipt")
		dn_before = self._count_tag_docs("delivery_note")
		# Known zebra pipeline side-effect doctypes (this test module only enables Stock Entry).
		# If the pipeline starts mutating other doctypes, extend this list and prove invariants explicitly.
		se_before = frappe.db.count("Stock Entry", {"remarks": ["like", f"%EVENT={event_id}%"]})
		tag_fields = [
			"purchase_receipt",
			"delivery_note",
			"status",
			"last_error",
			"last_event_id",
			"last_batch_id",
			"last_seq",
			"last_device_id",
			"modified",
		]
		tag_before = self._snapshot_row("RFID Zebra Tag", {"epc": epc}, tag_fields)
		linked_before = {}
		if tag_before:
			linked_before = {
				"purchase_receipt": str(tag_before.get("purchase_receipt") or ""),
				"delivery_note": str(tag_before.get("delivery_note") or ""),
			}
			if linked_before["purchase_receipt"]:
				receipt_doctype = self._resolve_receipt_doctype(linked_before["purchase_receipt"])
				self.assertEqual(frappe.db.count(receipt_doctype, {"name": linked_before["purchase_receipt"]}), 1)
			if linked_before["delivery_note"]:
				self.assertEqual(frappe.db.count("Delivery Note", {"name": linked_before["delivery_note"]}), 1)

		with patch("frappe.publish_realtime") as publish:
			res = api.ingest_tags(
				device=self.device_id,
				event_id=event_id,
				batch_id=self.batch_id,
				seq=1,
				ts=ts_epoch,
				tags=[{"epcId": epc, "antId": 1, "count": 1}],
			)
			publish.assert_not_called()

		self.assertTrue(res.get("duplicate"))
		edge_after_device = frappe.db.count("RFID Edge Event", {"device_id": self.device_id})
		edge_after_event = frappe.db.count("RFID Edge Event", {"event_id": event_id})
		state_after = self._snapshot_row("RFID Batch State", {"device_id": self.device_id}, state_fields)
		saved_after = self._snapshot_row("RFID Saved Tag", {"epc": epc}, saved_fields)
		saved_day_after = self._snapshot_row("RFID Saved Tag Day", {"epc": epc, "day": day}, saved_fields)
		dedupe_after = frappe.db.count("RFID Zebra Dedupe", {"idempotency_key": ["like", f"%{event_id}%"]})
		stock_after = self._count_tag_docs("purchase_receipt")
		dn_after = self._count_tag_docs("delivery_note")
		se_after = frappe.db.count("Stock Entry", {"remarks": ["like", f"%EVENT={event_id}%"]})
		tag_after = self._snapshot_row("RFID Zebra Tag", {"epc": epc}, tag_fields)

		self.assertEqual(edge_before_device, edge_after_device)
		self.assertEqual(edge_before_event, edge_after_event)
		self.assertEqual(state_before, state_after)
		self.assertEqual(saved_before, saved_after)
		self.assertEqual(saved_day_before, saved_day_after)
		self.assertEqual(dedupe_before, dedupe_after)
		self.assertEqual(stock_before, stock_after)
		self.assertEqual(dn_before, dn_after)
		self.assertEqual(se_before, se_after)
		self.assertEqual(tag_before, tag_after)
		if linked_before.get("purchase_receipt"):
			receipt_doctype = self._resolve_receipt_doctype(str(linked_before["purchase_receipt"]))
			self.assertEqual(frappe.db.count(receipt_doctype, {"name": linked_before["purchase_receipt"]}), 1)
		if linked_before.get("delivery_note"):
			self.assertEqual(frappe.db.count("Delivery Note", {"name": linked_before["delivery_note"]}), 1)

	def test_ingest_tags_scan_recon_blocks(self) -> None:
		item_code = f"{self.TEST_PREFIX}-SCANREQ"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = self._new_epc(4)
		self._create_tag(
			epc=epc,
			item_code=item_code,
			uom=uom,
			status="Printed",
			printed=True,
			scan_recon_required=1,
		)

		event_id = self._new_event_id()
		_, ts_epoch, _ = self._midday_local_ts_and_day()
		res = api.ingest_tags(
			device=self.device_id,
			event_id=event_id,
			batch_id=self.batch_id,
			seq=2,
			ts=ts_epoch,
			tags=[{"epcId": epc, "antId": 1, "count": 1}],
		)
		self.assertTrue(res.get("ok"))
		self.assertFalse(frappe.db.get_value("RFID Zebra Tag", {"epc": epc}, "purchase_receipt"))

	def test_ingest_tags_after_print_creates_once(self) -> None:
		item_code = f"{self.TEST_PREFIX}-PRINTED"
		uom = self._ensure_master_data(item_code)
		self._ensure_rule()
		epc = self._new_epc(5)
		self._create_tag(epc=epc, item_code=item_code, uom=uom, status="Printed", printed=True)

		event_id = self._new_event_id()
		_, ts_epoch, _ = self._midday_local_ts_and_day()
		res1 = api.ingest_tags(
			device=self.device_id,
			event_id=event_id,
			batch_id=self.batch_id,
			seq=3,
			ts=ts_epoch,
			tags=[{"epcId": epc, "antId": 1, "count": 1}],
		)
		self.assertTrue(res1.get("ok"))
		edge_row = frappe.db.get_value("RFID Edge Event", {"event_id": event_id}, ["payload_json"], as_dict=True)
		self.assertTrue(edge_row and edge_row.get("payload_json"), "RFID Edge Event payload_json missing")
		payload = json.loads(edge_row.get("payload_json") or "{}")
		self.assertEqual(payload.get("ts"), ts_epoch)
		day_expected = self._saved_tag_bucket_day_iso()
		saved_day = frappe.db.get_value(
			"RFID Saved Tag Day",
			{"epc": epc, "day": day_expected},
			["day", "reads", "last_seen", "device"],
			as_dict=True,
		)
		self.assertTrue(saved_day, msg=f"Saved Tag Day missing for {epc} on {day_expected}")
		saved_day_value = saved_day.get("day")
		if hasattr(saved_day_value, "isoformat"):
			saved_day_value = saved_day_value.isoformat()
		self.assertEqual(saved_day_value, day_expected)

		receipt_name = frappe.db.get_value("RFID Zebra Tag", {"epc": epc}, "purchase_receipt")
		debug_row = frappe.db.get_value(
			"RFID Zebra Tag",
			{"epc": epc},
			[
				"status",
				"printed_at",
				"scan_recon_required",
				"consume_ant_id",
				"last_error",
				"last_event_id",
				"last_batch_id",
				"last_seq",
				"last_device_id",
			],
			as_dict=True,
		)
		self.assertTrue(receipt_name, msg=str(debug_row))
		receipt_doctype = self._resolve_receipt_doctype(receipt_name)
		self.assertEqual(frappe.db.count(receipt_doctype, {"name": receipt_name}), 1)
		tag_name = frappe.db.get_value("RFID Zebra Tag", {"epc": epc}, "name")
		tag = frappe.get_doc("RFID Zebra Tag", tag_name)
		self.assertEqual(tag.last_event_id, event_id)
		self.assertEqual(tag.last_batch_id, self.batch_id)
		self.assertEqual(int(tag.last_seq or 0), 3)
		self.assertEqual(tag.last_device_id, self.device_id)
		remarks = frappe.db.get_value(receipt_doctype, receipt_name, "remarks") or ""
		self.assertIn(f"EVENT={event_id}", remarks)
		self.assertIn(f"BATCH={self.batch_id}", remarks)
		self.assertIn("SEQ=3", remarks)

		res2 = api.ingest_tags(
			device=self.device_id,
			event_id=event_id,
			batch_id=self.batch_id,
			seq=3,
			ts=ts_epoch,
			tags=[{"epcId": epc, "antId": 1, "count": 1}],
		)
		self.assertTrue(res2.get("duplicate"))
		self.assertEqual(frappe.db.count(receipt_doctype, {"name": receipt_name}), 1)

	def test_upsert_antenna_rule_case_insensitive(self) -> None:
		device_base = f"{self.TEST_PREFIX}-case-device"
		frappe.db.delete("RFID Antenna Rule", {"device": ["like", f"%{device_base}%"]})

		res1 = api.upsert_antenna_rule(
			device=device_base.upper(),
			antenna_id=3,
			submit_stock_entry=1,
			create_delivery_note=0,
			submit_delivery_note=0,
		)
		self.assertTrue(res1.get("ok"))

		res2 = api.upsert_antenna_rule(
			device=device_base.lower(),
			antenna_id=3,
			submit_stock_entry=0,
			create_delivery_note=0,
			submit_delivery_note=0,
		)
		self.assertTrue(res2.get("ok"))

		rows = frappe.get_all(
			"RFID Antenna Rule",
			filters={"antenna_id": 3, "device": device_base.lower()},
			fields=["name", "device"],
		)
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0].get("device"), device_base.lower())

	def test_ingest_tags_dedup_device_key_uses_device_id(self) -> None:
		self.assertTrue(api._dedup_by_ant_enabled(), "rfidenter_dedup_by_ant must be enabled for this contract test")

		device = "DEV 1"
		epc = f"{self.EPC_PREFIX}000000000006"
		ant_id = 1
		expected_key = f"{api.SEEN_PREFIX}{api._normalize_device_id(device) or device}:{ant_id}:{epc}"
		sanitized_key = f"{api.SEEN_PREFIX}{api._sanitize_agent_id(device) or device}:{ant_id}:{epc}"

		cache_obj = frappe.cache()
		cache_obj.delete_value(expected_key)
		cache_obj.delete_value(sanitized_key)

		CacheCls = type(cache_obj)
		original_set_value = CacheCls.set_value
		assert not getattr(original_set_value, "__rfid_test_patch__", False), "Cache set_value already patched"

		def _capture_set_value(self, key, value, *args, **kwargs):
			assert original_set_value is not CacheCls.set_value, "Recursion guard: would recurse"
			set_keys.append(key)
			return original_set_value(self, key, value, *args, **kwargs)

		set_keys: list[str] = []
		_capture_set_value.__rfid_test_patch__ = True  # type: ignore[attr-defined]

		with patch.object(CacheCls, "set_value", new=_capture_set_value):
			_, ts_epoch, _ = self._midday_local_ts_and_day()
			api.ingest_tags(device=device, ts=ts_epoch, tags=[{"epcId": epc, "antId": ant_id, "count": 1}])

		self.assertIn(expected_key, set_keys)
		self.assertNotIn(sanitized_key, set_keys)
		self.assertIs(CacheCls.set_value, original_set_value)
		self.assertFalse(getattr(CacheCls.set_value, "__rfid_test_patch__", False))

	def test_normalize_device_id_contract(self) -> None:
		self.assertEqual(api._normalize_device_id(" DEV 1 "), "DEV 1")
		self.assertEqual(api._normalize_device_id(""), "")
		self.assertEqual(api._normalize_device_id(None), "")
		self.assertEqual(len(api._normalize_device_id("A" * 80)), 64)

	def test_ingest_tags_seq_regression(self) -> None:
		event_report_id = self._new_event_id()
		api.edge_event_report(
			event_id=event_report_id,
			device_id=self.device_id,
			batch_id=self.batch_id,
			seq=5,
			event_type="ingest_tags",
			payload={},
		)

		frappe.local.response = frappe._dict()
		event_ingest_id = self._new_event_id()
		_, ts_epoch, _ = self._midday_local_ts_and_day()
		res = api.ingest_tags(
			device=self.device_id,
			event_id=event_ingest_id,
			batch_id=self.batch_id,
			seq=4,
			ts=ts_epoch,
			tags=[{"epcId": self._new_epc(7), "antId": 1, "count": 1}],
		)
		self.assertFalse(res.get("ok"))
		self.assertEqual(res.get("code"), "SEQ_REGRESSION")
		self.assertEqual(frappe.local.response.get("http_status_code"), 409)

	def test_duplicate_antenna_rule_rejected(self) -> None:
		device_base = f"{self.TEST_PREFIX}-dup-device"
		frappe.get_doc(
			{
				"doctype": "RFID Antenna Rule",
				"device": device_base,
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
					"device": device_base.upper(),
					"antenna_id": 2,
					"submit_stock_entry": 1,
					"create_delivery_note": 0,
					"submit_delivery_note": 0,
				}
			).insert(ignore_permissions=True)
