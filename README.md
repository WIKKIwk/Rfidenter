# Overview
RFIDenter — ERPNext ichidagi zavod ish oqimini boshqaruvchi modul. U Edge mini-PC orqali tarozi oqimini qabul qiladi, stabil vaznni FSM + fast/slow filtrlash bilan aniqlaydi, batch rejimida Zebra bosishni (va ixtiyoriy RFID encode) ishga tushiradi, hamda ERPNextga ishonchli (idempotent) tarzda yozadi. Tizim SQLite outbox va idempotency orqali restart, tarmoq uzilishi va printer kechikishlarida ham double-print yoki ERP dublikatini oldini oladi.

# Who this is for
- Zavod operatorlari (batch bosishni ishga tushirish, to'xtatish, scan/reweigh holatlarini kuzatish).
- IT/OT adminlar (deploy, konfiguratsiya, monitoring, rollback).
- ERPNext administratorlari (integratsiya, ruxsatlar, autentifikatsiya).

# Safety invariants (must never be violated)
- Hech qachon double-print bo'lmasin (1 placement = 1 label).
- Hech qachon ERP dublikat yozuv bo'lmasin (idempotency majburiy).
- Removal gating majburiy: keyingi bosishga o'tishdan oldin vazn EMPTY holatga qaytishi kerak.
- Post-guard majburiy: lockdan keyin vazn o'zgarsa, oqim bloklanadi va reweigh talab qilinadi.
- Printer COMPLETED tasdiqlanmaguncha ERPga "printed" event yuborilmasin.

# Architecture
## Components
- ERPNext + RFIDenter (server): control-plane, event log, batch state, UI.
- Edge service (mini-PC): scale reader + FSM + outbox + printer transport.
- Zebra printer (TCP/CUPS/driver) va ixtiyoriy RFID encode.
- Scale (USB HID/Serial).

## Data flow
1) Operator UI orqali batch start qiladi.
2) Edge scale oqimini o'qiydi -> stable lock -> print/encode.
3) Printer COMPLETED tasdiqlansa -> ERPNextga event_report yuboriladi.
4) ERPNext eventni idempotent qabul qiladi va batch state yangilanadi.
5) Removal gating va post-guard shartlari bajarilganda keyingi cycle boshlanadi.

## State machine (FSM) summary
- WAIT_EMPTY -> LOADING -> SETTLING -> LOCKED -> PRINTING -> POST_GUARD -> WAIT_EMPTY.
- LOCKED dan keyin vazn o'zgarsa: PAUSED(REWEIGH_REQUIRED).
- Printer offline/paused/error: PAUSED(PRINTER_*).
- RFID unknown bo'lsa: ScanReconRequired (external scan recon kerak).

## Idempotency & outbox model
- Edge tarafda SQLite outbox: print + ERP eventlar navbatda saqlanadi.
- event_id va (device_id, batch_id, seq) UNIQUE bo'lishi shart.
- Restartdan keyin outbox qayta ishlanadi va duplicate yaratmaydi.

# Requirements
## Hardware
- Edge mini-PC: <TODO: minimal CPU/RAM/SSD>.
- Scale: <TODO: HID/Serial modeli>.
- Zebra printer: <TODO: model va ulanish turi>.

## Software
- ERPNext: <TODO: version>.
- Edge runtime: <TODO: .NET 8/Java/Node/etc>.
- OS: <TODO: distro va minimal versiya>.

## Network & firewall
- ERPNext host: <TODO: host:port>.
- Printer host: <TODO: host:port>.
- Edge outbound: ERPNext API, printer endpoint.

## Access & security
- ERPNext foydalanuvchi rol(i): RFIDer va kerak bo'lsa System Manager.
- Tokenlar: site token (server config) va user token (browser-local) farqli.

# Quick start (10 minutes)
1) ERPNext appni o'rnating.
   Kutiladigan natija: RFIDenter app ERPNextga install bo'ladi.
   TODO: <install command>

2) Migrate/upgrade qiling.
   Kutiladigan natija: DocType va migratsiyalar qo'llanadi.
   TODO: <migrate command>

3) ERPNext restart.
   Kutiladigan natija: yangi UI sahifalari ko'rinadi.
   TODO: <restart command>

4) UIga kiring: <ERP_BASE_URL>/app/rfidenter-settings.
   Kutiladigan natija: Token/Agent/Zebra status panel chiqadi.

5) User token yarating (Settings sahifasida).
   Kutiladigan natija: User Token (browser-local) qiymati paydo bo'ladi.

6) Site token holatini tekshiring.
   Kutiladigan natija: Site Token (server effective) masked ko'rinadi yoki "not set".

7) Edge service ishga tushiring.
   Kutiladigan natija: device_status/heartbeat yangilanadi.
   TODO: <edge start command>

8) Zebra printer test bosish.
   Kutiladigan natija: test label bosiladi va UIda status ok.
   TODO: <print test command>

9) Batch start va stabil vazn bilan bosish.
   Kutiladigan natija: 1 placement = 1 label, ERP event log yoziladi.

# Configuration reference (every env var)
Quyidagi qiymatlar inventarizatsiyasi. Unknown bo'lsa TODO bilan belgilangan.

## ERP site_config.json keys
- rfidenter_token
  - Ma'no: ingest endpoint himoyasi.
  - Default: "" (bo'sh).
  - Validatsiya: bo'sh bo'lmasa string.
  - Xato simptomi: Guest ingest ruxsat xatosi yoki loopback-only.

- rfidenter_agent_ttl_sec
  - Ma'no: agent online TTL.
  - Default: 60.
  - Xato simptomi: agent offline ko'rinishi tez-tez o'chib-yonishi.

- rfidenter_dedup_by_ant
  - Ma'no: antenna bo'yicha dedup.
  - Default: True.
  - Xato simptomi: bir EPC ko'p qayta sanalishi.

- rfidenter_dedup_ttl_sec
  - Ma'no: dedup TTL (sekund).
  - Default: 86400.
  - Xato simptomi: eski EPC qayta kirib kelishi.

- rfidenter_antenna_ttl_sec
  - Ma'no: antenna statistik TTL (sekund).
  - Default: 600.
  - Xato simptomi: UIda antenna holati tez yo'qolishi.

- rfidenter_scale_ttl_sec
  - Ma'no: scale cache TTL (sekund).
  - Default: 300.
  - Xato simptomi: scale qiymati tez yo'qolishi.

- rfidenter_rpc_timeout_sec
  - Ma'no: agent RPC timeout.
  - Default: 30.
  - Xato simptomi: agent javob bermaydi/timeout.

## Edge service env/config (TODO)
- TODO: <edge env var list, default, validation, failure symptom>

# Deployment
## Docker Compose
N/A (TODO: agar compose mavjud bo'lsa file nomi va run steps).

## systemd
N/A (TODO: agar systemd unit mavjud bo'lsa unit nomi va run steps).

# Operations runbook (operators)
## Daily workflow
1) Settings sahifasida tokenlar holatini tekshiring.
   Kutiladigan natija: User Token bor, Site Token holati ko'rinadi.
2) Zebra sahifasida batch start qiling.
   Kutiladigan natija: Batch state Running.
3) Tarozi ustiga mahsulot qo'ying, stabil bo'lganda label bosiladi.
   Kutiladigan natija: 1 placement = 1 label.
4) Mahsulotni olib tashlang (EMPTY holatga qaytsin).
   Kutiladigan natija: keyingi bosish tayyor.

## Do/Don’t
- Do: EMPTY holatga qaytishini kuting.
- Do: PRINTER_PAUSED/ERROR/SCAN_REQUIRED holatlarida operator aralashuvi.
- Don't: bir placementda bir necha bosish.
- Don't: ERP eventlarini qo'lda qayta yuborish.

## Stop conditions (when to halt production)
- Printer ERROR yoki OFFLINE bo'lsa.
- Reweigh required holati takrorlansa.
- ERP auth xatosi ketma-ket bo'lsa.

# Monitoring & logging
- ERPNext log: <TODO: path/command>.
- Edge log: <TODO: path/command>.
- Key metrics: outbox depth, printer status, last_event_seq, batch state.

# Backup, restore, rollback
1) ERP backup:
   Kutiladigan natija: database + files snapshot olinadi.
   TODO: <backup command>
2) SQLite outbox backup:
   Kutiladigan natija: outbox fayli xavfsiz ko'chiriladi.
   TODO: <outbox path + copy command>
3) Restore:
   Kutiladigan natija: ERP va outbox bir xil nuqtaga qaytadi.
   TODO: <restore steps>
4) Rollback:
   Kutiladigan natija: oldingi versiya ishga tushadi.
   TODO: <rollback steps>

# Troubleshooting (symptom → cause → verify → fix)
- Symptom: Site token "not authorized".
  Cause: System Manager roli yo'q.
  Verify: ERP user role list.
  Fix: System Manager rolini qo'shing.

- Symptom: "unavailable".
  Cause: tarmoq offline yoki serverga ulanish yo'q.
  Verify: ping/healthcheck.
  Fix: tarmoqni tiklang.

- Symptom: double print.
  Cause: removal gating buzilgan yoki FSM state noto'g'ri.
  Verify: Edge log va FSM state.
  Fix: Edge service config va thresholdsni tekshiring.

- Symptom: ERP duplicate.
  Cause: idempotency yoki outbox muammosi.
  Verify: event_id va seq uniqueness.
  Fix: outbox DB va ERP log tekshiruvi.

# FAQ
- Site token va user token farqi nima?
  Site token — server config; User token — browser-local. Ikkalasi alohida.

- Qachon scan recon talab qilinadi?
  RFID unknown bo'lsa; operator tashqi recon qiladi.

# Appendix
## Common commands
- ERP migrate: <TODO>
- ERP restart: <TODO>
- Edge start/stop: <TODO>

## Example .env (redacted)
TODO: <env template with redacted secrets>
