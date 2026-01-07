# RFIDENTER
# ======================================================================
# ERPNext app for RFID ingest, Zebra workflows, and real time dashboards.

## >>> What This Is
RFIDenter is a custom ERPNext app that receives RFID tag reads, stores
and aggregates them, and exposes real time dashboards for operators. It
also connects to the local Zebra RFID printer workflow and can auto
submit stock entries when tags are read.

This README is written for non-developers. You can follow it step by
step without knowing how to code.

## >>> Who This Is For
- Operators who need a simple dashboard for RFID reads.
- IT admins who must connect RFID hardware with ERPNext.
- Warehouse teams using Zebra RFID printers and UHF readers.

## >>> Key Features
- Real time ingest of tag reads from local RFID services.
- Auto de-duplication per EPC and antenna.
- Live dashboards and historical storage.
- Zebra RFID print flow with Stock Entry integration.
- Optional scale (tarozi) realtime weight updates.
- Token based access control for secure ingest.

## >>> Architecture Overview

```
   UHF Reader / Local Agent
            |
            |  HTTP POST (ingest tags)
            v
      ERPNext (RFIDenter)
            |
            |  Real time events
            v
      ERPNext UI Dashboards

   Zebra Bridge (local) <--> Zebra Printer
            |
            |  HTTP / ERP agent
            v
      ERPNext (RFIDenter)
```

## >>> Quick Start (ERPNext Bench)
1) Install the app on your site:

```
bench --site <your-site> install-app rfidenter
```

2) Run migrations (safe to run multiple times):

```
bench --site <your-site> migrate
```

3) Start or restart bench:

```
bench start
```

4) Open the UI:
- RFIDenter main page: /app/rfidenter
- RFIDenter Zebra page: /app/rfidenter-zebra
- RFIDenter Antenna list: /app/rfidenter-antenna

## >>> Configuration (Site Config)
Edit your site config file:
```
<bench>/sites/<your-site>/site_config.json
```

Example configuration:
```
{
  "rfidenter_token": "YOUR_SHARED_SECRET",
  "rfidenter_agent_ttl_sec": 60,
  "rfidenter_dedup_by_ant": true,
  "rfidenter_dedup_ttl_sec": 86400,
  "rfidenter_scale_ttl_sec": 300
}
```

Notes:
- rfidenter_token protects the ingest endpoint from unauthorized use.
- rfidenter_dedup_by_ant reduces duplicate reads per antenna.

## >>> RFID Tag Ingest API
Endpoint:
```
POST /api/method/rfidenter.rfidenter.api.ingest_tags
```

Headers (recommended):
```
Authorization: token <api_key>:<api_secret>
X-RFIDenter-Token: <rfidenter_token>
```

Body example:
```
{
  "device": "reader-01",
  "tags": [
    { "epcId": "3034257BF7194E4000000001", "antId": 1, "rssi": 68 },
    { "epcId": "3034257BF7194E4000000002", "antId": 2, "rssi": 72 }
  ],
  "ts": 1730000000000
}
```

## >>> Zebra RFID Print Workflow
- Printing a tag creates a Stock Entry in Draft state.
- Stock Entry type is Material Issue (not Material Receipt).
- When UHF reader reads the tag later, RFIDenter auto-submits that Stock Entry.

This lets operators print first, and finalize stock movement only after
physical verification.

## >>> Scale (Tarozi) Integration
If you use a USB scale with the Zebra bridge:
- The Zebra bridge reads weight and pushes it to ERPNext.
- RFIDenter shows the live weight and can auto-fill Qty and UOM.

ERP endpoints:
```
POST /api/method/rfidenter.rfidenter.api.ingest_scale_weight
GET  /api/method/rfidenter.rfidenter.api.get_scale_weight
```

## >>> Security Notes
- Always set rfidenter_token in site_config.json.
- Use ERPNext API keys for production environments.
- Do not expose local Zebra services directly to the internet.

## >>> Troubleshooting
1) No tags appear in the UI:
   - Confirm the ingest API is reachable.
   - Verify rfidenter_token matches the sender header.

2) Zebra items do not submit:
   - Make sure the UHF reader is sending tag reads into ingest_tags.

3) Scale weight does not update:
   - Check Zebra bridge port settings.
   - Confirm scale is sending data over serial.

4) Permission errors:
   - Ensure your ERP user has the RFIDer role.

## >>> License
Apache License 2.0. See LICENSE and license.txt.
