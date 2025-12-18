# ERPNext (RFIDenter custom app)

Bu papkada ERPNext/Frappe uchun `rfidenter` custom app bor.

## Tez o‘rnatish (Linux)

1) ERPNext bench serverda `rfidenter` ni o‘rnating:

```bash
./erpnext-apps/install-rfidenter.sh /path/to/bench erp.localhost
```

2) ERPNext’ga kiring va `RFIDer` rolini user’ga bering.

3) Ochish:

- `http://<ERP_DOMAIN>/app/rfidenter`
- Token: `http://<ERP_DOMAIN>/app/rfidenter-auth`
- Read (unique EPC+ANT): `http://<ERP_DOMAIN>/app/rfidenter-antenna`

## Xavfsizlik (tavsiya)

Agar Node agent ERP serverga internet orqali yuborsa:

```bash
cd /path/to/bench
bench --site erp.localhost set-config rfidenter_token "YOUR_SECRET"
```

Node tomonda:

```bash
export RFIDENTER_TOKEN="YOUR_SECRET"
```

