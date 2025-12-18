# ST-8504 / UHFReader288 — Web UI (Local) + ERPNext (RFIDenter)

Bu repo 2 qismdan iborat:

1) **Local Web UI (Node)** — reader ulangan kompyuterda ishlaydi.
2) **ERPNext custom app (RFIDenter)** — taglarni ERP ichida realtime ko‘rsatadi (unique EPC+ANT).

## Local Web UI (Node)

```bash
./start-web.sh
```

Brauzer: `http://127.0.0.1:8787`

## ERPNext (RFIDenter app)

`erpnext-apps/` ichida `rfidenter` custom app bor.

```bash
./erpnext-apps/install-rfidenter.sh /path/to/bench erp.localhost
```

So‘ng ERPNext’da user’ga `RFIDer` rolini bering va `/app/rfidenter` ni oching.

