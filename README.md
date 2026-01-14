# Overview
RFIDenter is an ERPNext-integrated factory workflow system. An Edge mini-PC reads a USB scale stream, detects stable weight via an FSM with fast/slow filtering, triggers Zebra print (and optional RFID encode) in batch mode, enforces removal gating, and reports events to ERPNext with idempotency. Reliability is guaranteed by SQLite outbox + idempotency so restarts and network failures do not cause double print or duplicate ERP writes.

# Who this is for
- Plant operators running batch weighing and label printing.
- IT/OT administrators deploying and monitoring the edge service.
- ERPNext administrators responsible for integration and access control.

# Safety invariants (must never be violated)
- Never double-print (1 placement = 1 label).
- Never create duplicate ERP writes (idempotent event processing).
- Removal gating is mandatory: the scale must return to EMPTY before the next print.
- Post-guard is mandatory: if weight changes after lock, the system must block and require reweigh.
- ERP events must be sent only after printer COMPLETED (or Scan Recon resolved).

# Architecture
## Components
- ERPNext + RFIDenter app (control plane, event log, batch state, UI).
- Edge service on mini-PC (scale reader, FSM, outbox, printer transport).
- Zebra printer (TCP/CUPS/driver).
- Scale device (USB HID/Serial).

## Data flow
1) Operator starts a batch in ERPNext UI.
2) Edge reads scale stream and detects stable lock.
3) Edge triggers Zebra print/encode.
4) Printer COMPLETED is confirmed.
5) Edge posts event to ERPNext with idempotency keys.
6) ERPNext updates batch state and audit log.

## State machine (FSM) summary
- WAIT_EMPTY -> LOADING -> SETTLING -> LOCKED -> PRINTING -> POST_GUARD -> WAIT_EMPTY.
- If weight changes after lock: PAUSED (REWEIGH_REQUIRED).
- If printer offline/paused/error: PAUSED (PRINTER_*).
- If RFID unknown: ScanReconRequired until external recon event arrives.

## Idempotency & outbox model
- Edge maintains SQLite outbox for print + ERP events.
- event_id is UNIQUE; (device_id, batch_id, seq) is UNIQUE.
- On restart, outbox is replayed without double-print or ERP duplicates.

# Requirements
## Hardware
- Edge mini-PC: <TODO: minimum CPU/RAM/SSD>.
- Scale device: <TODO: model, connection type>.
- Zebra printer: <TODO: model, connection type>.

## Software
- ERPNext: <TODO: version>.
- Edge runtime: <TODO: .NET/Node/Java version>.
- OS: <TODO: distro and minimal version>.

## Network & firewall
- ERPNext host: <TODO: host:port>.
- Zebra printer endpoint: <TODO: host:port>.
- Edge outbound: ERPNext API and printer endpoint.

## Access & security
- ERPNext roles: RFIDer; System Manager for site token visibility.
- Site token (server config) and user token (browser-local) are different.

# Quick start (10 minutes)
1) Install the app.
   Kutiladigan natija (Expected result): RFIDenter app is installed in ERPNext.
   TODO: <install command>

2) Run migrations.
   Kutiladigan natija (Expected result): DocTypes and migrations are applied.
   TODO: <migrate command>

3) Restart ERPNext services.
   Kutiladigan natija (Expected result): UI pages are available.
   TODO: <restart command>

4) Open Settings UI.
   Kutiladigan natija (Expected result): Token and device panels render.
   URL: <ERP_BASE_URL>/app/rfidenter-settings

5) Generate a user token.
   Kutiladigan natija (Expected result): "User Token (browser-local)" shows a value.

6) Verify site token status.
   Kutiladigan natija (Expected result): "Site Token (server config, effective)" shows masked value or "not set".

7) Start Edge service.
   Kutiladigan natija (Expected result): device_status/heartbeat updates in UI.
   TODO: <edge start command>

8) Run a print test.
   Kutiladigan natija (Expected result): Zebra prints a test label.
   TODO: <print test command>

9) Run a full batch cycle.
   Kutiladigan natija (Expected result): 1 placement = 1 label, ERP event log updated.

# Configuration reference (every env var)
## ERP site_config.json keys
- rfidenter_token
  - Meaning: shared token for ingest/auth.
  - Default: "" (empty).
  - Validation: non-empty string for protected ingest.
  - Failure symptom: ingest rejected or loopback-only.

- rfidenter_agent_ttl_sec
  - Meaning: agent online TTL.
  - Default: 60.
  - Failure symptom: agent flips offline/online rapidly.

- rfidenter_dedup_by_ant
  - Meaning: deduplicate reads per antenna.
  - Default: true.
  - Failure symptom: repeated reads inflate counts.

- rfidenter_dedup_ttl_sec
  - Meaning: dedup TTL seconds.
  - Default: 86400.
  - Failure symptom: old EPCs reappear too early.

- rfidenter_antenna_ttl_sec
  - Meaning: antenna stats TTL seconds.
  - Default: 600.
  - Failure symptom: antenna stats disappear too quickly.

- rfidenter_scale_ttl_sec
  - Meaning: scale cache TTL seconds.
  - Default: 300.
  - Failure symptom: scale value disappears too quickly.

- rfidenter_rpc_timeout_sec
  - Meaning: agent RPC timeout seconds.
  - Default: 30.
  - Failure symptom: agent calls timeout.

## Edge service configuration
- TODO: <list every env var, default, validation, failure symptom>

# Deployment
## Docker Compose
N/A (TODO: provide compose file path and exact commands).

## systemd
N/A (TODO: provide unit file name and exact commands).

# Operations runbook (operators)
## Daily workflow
1) Check tokens on Settings page.
   Kutiladigan natija (Expected result): user token present; site token shows masked value or not set.
2) Start batch on Zebra UI.
   Kutiladigan natija (Expected result): state Running.
3) Place product on scale until stable lock; label prints.
   Kutiladigan natija (Expected result): 1 placement = 1 label.
4) Remove product; wait for EMPTY.
   Kutiladigan natija (Expected result): next cycle is armed.

## Do/Don’t
- Do: wait for EMPTY before next placement.
- Do: stop and investigate if PRINTER_* or REWEIGH_REQUIRED appears.
- Don’t: attempt manual reprint without resolving scan recon.
- Don’t: restart Edge during active print unless instructed.

## Stop conditions (when to halt production)
- Printer OFFLINE/ERROR persists.
- Reweigh required repeats without resolution.
- ERP auth failures persist.

# Monitoring & logging
- ERP logs: <TODO: path/command>.
- Edge logs: <TODO: path/command>.
- Key metrics: outbox depth, printer status, last_event_seq, batch state, reconnect rate.

# Backup, restore, rollback
1) ERP backup.
   Kutiladigan natija (Expected result): DB + files snapshot created.
   TODO: <backup command>

2) SQLite outbox backup.
   Kutiladigan natija (Expected result): outbox DB copied safely.
   TODO: <outbox path + copy command>

3) Restore.
   Kutiladigan natija (Expected result): ERP + outbox restored to same point.
   TODO: <restore steps>

4) Rollback.
   Kutiladigan natija (Expected result): previous version runs without data loss.
   TODO: <rollback steps>

# Troubleshooting (symptom → cause → verify → fix)
- Symptom: Site token shows "not authorized (System Manager only)".
  Cause: user lacks System Manager role.
  Verify: user roles in ERP.
  Fix: assign System Manager or login as Administrator.

- Symptom: Site token shows "unavailable".
  Cause: network/offline/timeout.
  Verify: healthcheck endpoint.
  Fix: restore network or ERP service.

- Symptom: double print observed.
  Cause: removal gating or FSM state violation.
  Verify: Edge logs + FSM state.
  Fix: check scale stability parameters and gating rules.

- Symptom: ERP duplicates.
  Cause: idempotency keys missing or outbox replay misconfig.
  Verify: event_id/seq uniqueness in ERP logs.
  Fix: restore outbox and verify config.

# FAQ
- Q: What is the difference between site token and user token?
  A: Site token is server configuration; user token is browser-local for agent/UI.

- Q: When is Scan Recon required?
  A: When RFID status is unknown; system blocks until recon event arrives.

# Appendix
## Common commands
- ERP migrate: <TODO>
- ERP restart: <TODO>
- Edge start/stop: <TODO>

## Example .env (redacted)
TODO: <env template with redacted secrets>
