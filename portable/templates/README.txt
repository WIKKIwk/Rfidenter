RFID Agent Portable (Linux)
===========================

Quick start (no install):

  ./start-web.sh

This starts the local web UI and the TUI together.
Default web URL: http://127.0.0.1:8787

Terminal-only mode:

  ./start-tui.sh

Online mode will ask for ERP URL and token (api_key:api_secret).
Offline mode writes logs to: rfid/Demo/web-localhost/logs/

Install as service (auto-start on boot):

  sudo ./install.sh

USB permissions:
- install.sh adds udev rules for /dev/ttyUSB* and /dev/ttyACM*

Environment overrides:
- PORT=8787 (web port)
- HOST=127.0.0.1 (bind address)
- RFID_TUI_API_STARTSTOP=1 (allow start/stop in API mode)

Architecture note:
- This bundle is linux-x64 by default. For arm64, request the arm64 build.
