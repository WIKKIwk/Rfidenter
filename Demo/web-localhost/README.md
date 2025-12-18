# ST-8504 / UHFReader288 — Localhost Web UI (Linux)

This is a **localhost web UI** (browser-based) to use the reader on Linux.

It runs **only on your own PC** (binds to `127.0.0.1`) and talks to the reader via the provided **Linux Java SDK**: `SDK/Java-linux/CReader.jar`.

## What works in v1

- Connect/disconnect (TCP/IP)
- Inventory (start/stop, live tag stream, antenna mask, session/Q/scan-time)
- Read/Write by EPC (Password/EPC/TID/User banks)
- Set RF power / region / antenna selection for inventory
- GPIO set/get (if supported by your firmware)

## Limitations

- **USB/RS232 direct support is not included yet** because this SDK folder only ships a TCP/IP Java API for Linux (`CReader.jar`).  
  If you must use USB/RS232 on Linux, you’ll need either:
  - a vendor **Linux serial SDK / protocol spec**, or
  - use the Windows tools via `wine`.

## Requirements

- `node` (Node.js 18+ recommended)
- `java` (JRE is enough)

## Run

From this folder:

1) Build the Java bridge (one-time):

`./build-bridge.sh`

2) Start the web app:

`./run.sh`

3) Open:

`http://127.0.0.1:8787`

If you need a different port:

`PORT=8787 ./run.sh`

