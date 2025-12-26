```
██╗   ██╗██╗  ██╗███████╗
██║   ██║██║  ██║██╔════╝
██║   ██║███████║█████╗  
██║   ██║██╔══██║██╔══╝  
╚██████╔╝██║  ██║██║     
 ╚═════╝ ╚═╝  ╚═╝╚═╝     
                         
██████╗ ███████╗ █████╗ ██████╗ ███████╗██████╗     ██████╗  █████╗  █████╗ 
██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝██╔══██╗    ╚════██╗██╔══██╗██╔══██╗
██████╔╝█████╗  ███████║██║  ██║█████╗  ██████╔╝     █████╔╝╚█████╔╝╚█████╔╝
██╔══██╗██╔══╝  ██╔══██║██║  ██║██╔══╝  ██╔══██╗    ██╔═══╝  ╚═══██╗ ╚═══██╗
██║  ██║███████╗██║  ██║██████╔╝███████╗██║  ██║    ███████╗ █████╔╝ █████╔╝
╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝    ╚══════╝ ╚════╝  ╚════╝ 
```

# ST-8504 / UHFREADER288 :: RFID INTEGRATION PLATFORM

```
HARDWARE: ST-8504 / UHFReader288 RFID Device
INTERFACES: USB/Serial Communication (Java SDK)
COMPONENTS: Local Web UI (Node.js) + ERPNext Integration
PROTOCOL: UHF RFID Gen2 (ISO 18000-6C/EPC C1 G2)
DEPLOYMENT: Multi-tier (Local Hardware Control + Cloud ERP)
```

---

## SYSTEM OVERVIEW

```
Dual-component architecture providing real-time RFID tag management:
1. Local web interface for direct RFID reader hardware control
2. ERPNext custom application for centralized tag tracking

DEPLOYMENT TOPOLOGY
┌────────────────────────────────────────────────────────────┐
│                    Local Hardware Layer                    │
│  ┌──────────────┐      ┌─────────────────────┐            │
│  │ UHFReader288 │◄─USB─►│ Java SDK Bridge     │            │
│  │ RFID Device  │      │ (Native Library)    │            │
│  └──────────────┘      └─────────┬───────────┘            │
│                                  │                         │
│                        ┌─────────▼──────────┐              │
│                        │ Node.js Web Server │              │
│                        │ (Port 8787)        │              │
│                        └─────────┬──────────┘              │
└──────────────────────────────────┼─────────────────────────┘
                                   │ HTTP/WebSocket
                   ┌───────────────▼───────────────┐
                   │   Browser Client (Local)      │
                   │   Tag Read Interface          │
                   └───────────────┬───────────────┘
                                   │ HTTP REST API
                   ┌───────────────▼───────────────┐
                   │   ERPNext Server (Remote)     │
                   │   RFIDenter Custom App        │
                   │   Real-time Tag Dashboard     │
                   └───────────────────────────────┘

CRITICAL: Java SDK requires USB connection to physical RFID reader.
          Local web UI must run on same machine as reader hardware.
```

---

## COMPONENT ARCHITECTURE

### [COMPONENT 1] LOCAL WEB INTERFACE

```
Technology Stack:
├── Runtime: Node.js 18+
├── Web Server: Express.js (port 8787)
├── Hardware Bridge: Java SDK native library
├── Communication: USB/Serial via JNI bindings
└── Frontend: HTML5 + WebSocket real-time updates

Capabilities:
├── Direct RFID reader control
├── Tag read/write operations
├── Antenna configuration management
├── Real-time tag detection display
├── EPC (Electronic Product Code) capture
├── Reader firmware status monitoring
└── Multi-antenna support (up to 4 antennas)

Launch Scripts:
├── start-web.sh ........... Linux/macOS launcher
├── start-web.cmd .......... Windows batch script
└── start-web.ps1 .......... PowerShell script
```

### [COMPONENT 2] ERPNEXT INTEGRATION

```
Component Name: RFIDenter (Custom Frappe/ERPNext App)
Installation Target: ERPNext v15.x bench
Database: MariaDB/PostgreSQL (via Frappe ORM)

Features:
├── Real-time tag tracking dashboard
├── Unique EPC + Antenna combination logging
├── Token-based authentication (optional)
├── Role-based access ("RFIDer" role)
├── RESTful API for tag ingestion
├── Historical tag read database
└── Multi-site support

DocTypes:
├── RFIDenter Auth ......... Token management
├── RFIDenter .............. Main dashboard
└── RFIDenter Antenna ...... Tag read records (EPC+ANT)

Access URLs:
├── /app/rfidenter .......... Main dashboard
├── /app/rfidenter-auth ..... Token configuration
└── /app/rfidenter-antenna .. Tag read logs
```

---

## TECHNICAL REQUIREMENTS

### HARDWARE PREREQUISITES

```
RFID Reader Device:
├── Model: ST-8504 or UHFReader288
├── Interface: USB (CP210x USB-to-Serial bridge)
├── Protocol: UHF RFID Gen2 (ISO 18000-6C)
├── Frequency: 860-960 MHz (region-dependent)
├── Read Range: Up to 8 meters (antenna-dependent)
└── Antenna Ports: 1-4 (configurable)

Host System:
├── USB Port: Available USB 2.0+ port
├── Driver: CP210x UART driver installed
└── Java: OpenJDK/Oracle JDK 8+ (for SDK bridge)
```

### SOFTWARE DEPENDENCIES

```
Local Web UI:
├── Node.js: 18.x or higher
├── npm: 9.x or higher
├── Java Runtime: JRE 8+ (for native SDK)
└── Operating System: Linux, macOS, Windows

ERPNext Integration:
├── Frappe Framework: v15.x
├── ERPNext: v15.x (required)
├── Python: 3.10+
├── MariaDB: 10.6+ or PostgreSQL: 14+
└── Redis: 6.x+ (Frappe requirement)

Network:
├── Local Network: For browser → web server (localhost)
├── Internet: For web server → ERPNext API (optional)
└── Firewall: Allow outbound HTTPS if using remote ERP
```

---

## DEPLOYMENT PROTOCOLS

### [PROTOCOL 1] LOCAL WEB UI DEPLOYMENT

```bash
# Step 1: Clone repository
git clone https://github.com/WIKKIwk/ERPNext_UHFReader288_integration.git
cd ERPNext_UHFReader288_integration

# Step 2: Verify Java installation
java -version
# Expected: JRE/JDK 8 or higher

# Step 3: Connect RFID reader hardware
# - Attach reader via USB cable
# - Verify driver installation (CP210x)
# - Confirm device enumeration (Linux: /dev/ttyUSB*, Windows: COM*)

# Step 4: Launch web server
./start-web.sh         # Linux/macOS
# OR
start-web.cmd          # Windows CMD
# OR
start-web.ps1          # Windows PowerShell

# Step 5: Access web interface
# Browser: http://127.0.0.1:8787
```

**AUTO-STARTUP SEQUENCE:**
1. Java SDK native library initialization
2. USB device detection and connection
3. Reader firmware handshake
4. Node.js web server startup (port 8787)
5. WebSocket channel establishment
6. HTTP server activation

**VERIFICATION:**
```bash
# Check web server status
curl http://127.0.0.1:8787/health
# Expected: HTTP 200 OK

# Monitor server logs
tail -f Demo/web-localhost/logs/server.log
```

### [PROTOCOL 2] ERPNEXT APP INSTALLATION

#### AUTOMATED INSTALLATION (Linux)

```bash
# Navigate to ERPNext bench directory
cd /path/to/your/bench

# Execute installation script
./path/to/repo/erpnext-apps/install-rfidenter.sh \
  /path/to/bench \
  your-site-name.local

# Example:
./erpnext-apps/install-rfidenter.sh \
  /home/frappe/frappe-bench \
  erp.company.com
```

**INSTALLATION SEQUENCE EXECUTED:**
1. Validate bench directory and site existence
2. Backup existing rfidenter app (if present)
3. Copy rfidenter app to bench/apps/
4. Register app in sites/apps.txt
5. Install Python dependencies (pip install -e)
6. Run database migrations (bench migrate)
7. Build frontend assets (bench build)
8. Verify installation success

#### MANUAL INSTALLATION

```bash
# Step 1: Copy app to bench
cp -r erpnext-apps/rfidenter /path/to/bench/apps/

# Step 2: Register in apps.txt
echo "rfidenter" >> /path/to/bench/sites/apps.txt

# Step 3: Install Python package
cd /path/to/bench
source env/bin/activate
pip install -e apps/rfidenter

# Step 4: Install app on site
bench --site your-site-name install-app rfidenter

# Step 5: Migrate database
bench --site your-site-name migrate

# Step 6: Build assets
bench build --app rfidenter

# Step 7: Restart web server
bench restart
```

#### POST-INSTALLATION CONFIGURATION

```bash
# Step 1: Assign RFIDer role to users
# Navigate: ERPNext → Setup → Users → Select User → Roles
# Add: "RFIDer" role

# Step 2: Configure authentication token (optional - for remote access)
bench --site your-site-name set-config rfidenter_token "YOUR_SECRET_TOKEN"

# Step 3: Verify installation
bench --site your-site-name list-apps
# Expected: rfidenter in output

# Step 4: Access application
# URL: https://your-erp-domain.com/app/rfidenter
```

---

## CONFIGURATION MATRIX

### LOCAL WEB UI CONFIGURATION

```
Connection Settings (Auto-detected):
├── USB Device: Auto-discovery via Java SDK
├── Baud Rate: 115200 (default)
├── Port: 8787 (web server)
└── Antenna Configuration: Via web interface

Manual Configuration (if needed):
Location: Demo/web-localhost/config.json
```

### ERPNEXT INTEGRATION CONFIGURATION

```bash
# Token Authentication (Recommended for remote deployments)

# Server-side (ERPNext):
bench --site your-site-name set-config rfidenter_token "random_secure_token_here"

# Client-side (Node.js agent):
export RFIDENTER_TOKEN="random_secure_token_here"

# Security Notes:
# - Token sent in HTTP header: X-RFIDenter-Token
# - Required only for public internet deployments
# - Local network deployments can omit token
# - Rotate tokens every 90 days (recommended)
```

### FIREWALL CONFIGURATION

```bash
# Local System (where RFID reader connected):
# Allow inbound: TCP 8787 (web interface)
# Allow outbound: HTTPS 443 (to ERPNext server)

# ERPNext Server:
# Allow inbound: HTTPS 443 (from agent)
# Firewall rules (ufw example):
sudo ufw allow 443/tcp comment "ERPNext HTTPS"

# Nginx reverse proxy configuration (if applicable):
location /api/method/rfidenter {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

---

## OPERATIONAL PROCEDURES

### TAG READING WORKFLOW

```
Local Web Interface Operations:

[1] Connect RFID Reader
    - Plugin USB cable
    - Wait for device detection
    - Status LED: Solid green = ready

[2] Access Web Interface
    - Navigate: http://127.0.0.1:8787
    - Interface loads with reader status

[3] Configure Antenna
    - Select active antenna (1-4)
    - Set read power (0-30 dBm)
    - Configure read interval

[4] Start Scanning
    - Click "Start Read" button
    - Tags detected in real-time
    - EPC codes displayed in table

[5] View Tag Details
    - Click on detected tag
    - View full EPC, RSSI, antenna number
    - Export to CSV/JSON (optional)

Data Flow:
RFID Tag → Reader Antenna → USB → Java SDK → Node.js Bridge 
  → WebSocket → Browser Display → HTTP API → ERPNext Storage
```

### ERPNEXT DASHBOARD ACCESS

```
User Workflow:

[1] Login to ERPNext
    URL: https://your-erp-domain.com
    Credentials: ERPNext user account

[2] Access RFIDenter Dashboard
    Navigate: /app/rfidenter
    OR: Search "RFIDenter" in Awesome Bar

[3] View Real-time Tag Reads
    - Live table of tag reads
    - Columns: EPC, Antenna, Timestamp, RSSI
    - Auto-refresh (WebSocket or polling)

[4] Filter & Search
    - Filter by antenna number
    - Search by EPC code
    - Date range selection

[5] Export Data
    - CSV export functionality
    - PDF reports
    - Excel format
```

### TAG DATA SYNCHRONIZATION

```
Automatic Synchronization:
├── Trigger: Tag detected by local reader
├── Action: HTTP POST to ERPNext API
├── Endpoint: /api/method/rfidenter.api.log_tag_read
├── Payload: {epc: "...", antenna: 1, rssi: -45}
├── Response: 200 OK (success) or error code
└── Retry: 3 attempts with exponential backoff

Manual Synchronization:
├── Local storage: SQLite database in web UI
├── Batch upload: Via "Sync" button in UI
├── Conflict resolution: Newest timestamp wins
└── Offline mode: Queue and sync when online
```

---

## API REFERENCE

### LOCAL WEB UI API

```
Base URL: http://127.0.0.1:8787

GET /status
Response: {status: "connected", reader: "UHFReader288", version: "1.0"}
Description: Reader connection status

POST /read/start
Payload: {antenna: 1, power: 25}
Response: {success: true, session_id: "..."}
Description: Start tag reading session

POST /read/stop
Response: {success: true}
Description: Stop current reading session

GET /tags/recent
Response: [{epc: "...", antenna: 1, rssi: -42, timestamp: "..."}]
Description: Recent tag reads (last 100)

WebSocket: ws://127.0.0.1:8787/ws
Events: {event: "tag_read", data: {epc: "...", antenna: 1, rssi: -45}}
Description: Real-time tag read stream
```

### ERPNEXT RFIDENTER API

```
Base URL: https://your-erp-domain.com

POST /api/method/rfidenter.api.log_tag_read
Headers: X-RFIDenter-Token: YOUR_TOKEN (if configured)
Payload: {
  "epc": "E280689400005021DAD0F8B8",
  "antenna": 1,
  "rssi": -45,
  "timestamp": "2025-12-26T12:00:00Z"
}
Response: {message: "success", record_name: "RFA-00001"}

GET /api/method/rfidenter.api.get_recent_reads
Headers: Authorization: token API_KEY:API_SECRET
Params: limit=100, antenna=1
Response: {
  "data": [
    {
      "name": "RFA-00001",
      "epc": "E280689400005021DAD0F8B8",
      "antenna": 1,
      "rssi": -45,
      "timestamp": "2025-12-26T12:00:00Z"
    }
  ]
}

POST /api/method/rfidenter.api.clear_old_reads
Headers: Authorization: token API_KEY:API_SECRET
Payload: {days_to_keep: 7}
Response: {message: "success", deleted_count: 1234}
```

---

## DIRECTORY STRUCTURE

```
ERPNext_UHFReader288_integration/
├── README.md ...................... This documentation
├── start-web.sh ................... Linux/macOS launcher (wrapper)
├── start-web.cmd .................. Windows batch launcher
├── start-web.ps1 .................. PowerShell launcher
│
├── Demo/ .......................... Local web UI application
│   ├── start-web.sh ............... Actual server launcher
│   ├── start-web.cmd .............. Windows launcher
│   ├── start-web.ps1 .............. PowerShell launcher
│   └── web-localhost/ ............. Node.js application root
│       ├── server/ ................ Express.js server code
│       ├── web/ ................... Frontend assets (HTML/CSS/JS)
│       ├── tools/ ................. Utility scripts
│       ├── build-bridge.sh ........ Java SDK bridge builder
│       └── run.sh ................. Application runner
│
├── SDK/ ........................... Java SDK for UHFReader288
│   └── Java-linux/ ................ Linux native libraries
│       ├── libUHFReader288.so ..... Native JNI library
│       └── UHFReader288.jar ....... Java wrapper classes
│
└── erpnext-apps/ .................. ERPNext custom application
    ├── README.md .................. ERPNext app documentation
    ├── install-rfidenter.sh ....... Automated installer (Linux)
    ├── install-rfidenter.ps1 ...... Automated installer (Windows)
    └── rfidenter/ ................. Frappe/ERPNext app source
        ├── hooks.py ............... App configuration
        ├── patches.txt ............ Database migrations
        ├── modules.txt ............ Module definitions
        └── rfidenter/ ............. Python package
            ├── api.py ............. REST API endpoints
            ├── doctype/ ........... DocType definitions
            └── public/ ............ Frontend assets
```

---

## DIAGNOSTIC PROCEDURES

### ISSUE: Reader Not Detected

```
Diagnosis Sequence:
[1] Verify USB connection
    # Linux
    lsusb | grep -i "Silicon Labs\|CP210"
    # Expected: Bus 001 Device 003: ID 10c4:ea60 Silicon Labs
    
    # Windows
    Device Manager → Ports (COM & LPT)
    # Expected: Silicon Labs CP210x USB to UART Bridge (COM*)

[2] Check driver installation
    # Linux
    dmesg | grep -i cp210x
    # Expected: cp210x converter now attached to ttyUSB0
    
    # Windows
    # Download driver: https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers

[3] Verify permissions (Linux)
    sudo usermod -aG dialout $USER
    # Logout and login required

[4] Test serial communication
    # Linux
    screen /dev/ttyUSB0 115200
    # OR
    minicom -D /dev/ttyUSB0 -b 115200

Resolution:
- Install/reinstall CP210x drivers
- Check USB cable integrity
- Try different USB port
- Reboot system after driver installation
```

### ISSUE: Web Server Fails to Start

```
Diagnosis Sequence:
[1] Check port availability
    # Linux/macOS
    lsof -i :8787
    netstat -tuln | grep 8787
    
    # Windows
    netstat -ano | findstr :8787

[2] Verify Node.js installation
    node --version
    npm --version
    # Required: Node 18+, npm 9+

[3] Check Java Runtime
    java -version
    # Required: JRE 8+

[4] Review server logs
    tail -f Demo/web-localhost/logs/server.log
    tail -f Demo/web-localhost/logs/error.log

Resolution:
- Kill process using port 8787: kill -9 $(lsof -t -i:8787)
- Reinstall Node.js if version mismatch
- Install/update Java Runtime
- Check disk space for log files
```

### ISSUE: ERPNext App Installation Failure

```
Diagnosis Sequence:
[1] Verify bench status
    bench doctor
    # Check for errors

[2] Confirm site exists
    bench --site your-site-name list-apps
    # Site must be valid

[3] Check Redis services
    redis-cli -p 11000 ping  # Queue
    redis-cli -p 13000 ping  # Cache
    # Expected: PONG

[4] Review installation logs
    tail -f /path/to/bench/logs/bench.log

Resolution:
- Restart Redis: bench setup redis
- Clear cache: bench --site your-site-name clear-cache
- Reinstall app: bench --site your-site-name uninstall-app rfidenter
- Check Python dependencies: pip install -r apps/rfidenter/requirements.txt
```

### ISSUE: Tags Not Syncing to ERPNext

```
Diagnosis Sequence:
[1] Verify ERPNext API accessibility
    curl -I https://your-erp-domain.com
    # Expected: HTTP 200/301/302

[2] Check authentication token (if configured)
    # Server
    bench --site your-site-name get-config rfidenter_token
    
    # Client
    echo $RFIDENTER_TOKEN

[3] Test API endpoint manually
    curl -X POST https://your-erp-domain.com/api/method/rfidenter.api.log_tag_read \
      -H "Content-Type: application/json" \
      -H "X-RFIDenter-Token: YOUR_TOKEN" \
      -d '{"epc":"TEST","antenna":1,"rssi":-50}'

[4] Review network logs
    # Local UI
    tail -f Demo/web-localhost/logs/network.log

Resolution:
- Verify firewall allows outbound HTTPS
- Confirm token matches on both ends
- Check ERPNext error logs: bench --site your-site-name watch
- Verify RFIDer role assigned to API user
```

---

## SECURITY CONSIDERATIONS

```
AUTHENTICATION
├── Local Web UI: No authentication (localhost only)
├── ERPNext Integration: Token-based (optional)
│   ├── Token length: 32+ characters recommended
│   ├── Storage: Bench config (encrypted)
│   └── Transmission: HTTP header (HTTPS required)

NETWORK SECURITY
├── Local UI: Bind to 127.0.0.1 only (no public access)
├── ERPNext: HTTPS required for token transmission
├── Firewall: Restrict ERPNext access to known IPs
└── VPN: Recommended for remote agents

DATA SECURITY
├── Tag Data: No PII encryption (EPC codes only)
├── Audit Trail: Full read history in ERPNext
├── Access Control: ERPNext RBAC (RFIDer role)
└── Data Retention: Configurable cleanup policies

BEST PRACTICES
├── Use dedicated ERPNext API user for agent
├── Rotate authentication tokens quarterly
├── Enable HTTPS on ERPNext (Let's Encrypt)
├── Restrict /app/rfidenter-auth to admins only
├── Monitor API logs for unusual activity
└── Regular security updates (bench update)
```

---

## TROUBLESHOOTING GUIDE

```
Common Error Messages:

"Failed to open device"
→ USB connection issue or driver problem
→ Run: sudo chmod 666 /dev/ttyUSB0 (Linux)

"Port 8787 already in use"
→ Another process using port
→ Run: kill -9 $(lsof -t -i:8787)

"Java SDK not found"
→ Java not installed or wrong version
→ Install: sudo apt-get install default-jre

"ERPNext token mismatch"
→ Token configuration error
→ Verify: bench get-config rfidenter_token

"Cannot install app rfidenter"
→ Missing dependencies or bench issue
→ Run: bench setup requirements

Performance Optimization:

Slow Tag Reads:
├── Reduce read power if too many tags
├── Increase antenna selectivity
├── Adjust read interval
└── Check USB cable quality

High CPU Usage:
├── Limit active antennas to needed ones
├── Increase read interval
├── Disable debug logging
└── Close unused browser tabs

Network Latency:
├── Use local ERPNext instance if possible
├── Enable compression in Nginx
├── Implement tag read batching
└── Optimize database indexes
```

---

## DEVELOPMENT GUIDELINES

### LOCAL UI DEVELOPMENT

```bash
# Navigate to web application
cd Demo/web-localhost

# Install dependencies
cd server && npm install

# Run in development mode
npm run dev
# OR
node server.js --dev

# Frontend development
cd ../web
# Edit HTML/CSS/JS files
# Browser auto-reload via livereload (if configured)
```

### ERPNEXT APP DEVELOPMENT

```bash
# Navigate to app directory
cd erpnext-apps/rfidenter

# Make code changes
# Edit Python files in rfidenter/ directory

# Restart services to apply changes
bench --site your-site-name migrate
bench restart

# Watch for Python errors
bench --site your-site-name console
# OR
bench --site your-site-name watch

# Frontend changes
cd rfidenter/public
# Edit JS/CSS files
bench build --app rfidenter
```

---

## ROADMAP & ENHANCEMENTS

```
Planned Features:
├── Tag Write Functionality ....... Encode EPC data
├── Batch Read Operations ......... Multi-tag simultaneous read
├── Advanced Filtering ............ RSSI threshold, TID filtering
├── Mobile App Integration ........ iOS/Android apps
├── Grafana Dashboard ............. Real-time analytics
├── AI-powered Tag Tracking ....... Anomaly detection
└── Blockchain Integration ........ Immutable tag history

Performance Improvements:
├── WebAssembly SDK ............... Faster tag processing
├── Redis caching ................. Reduced ERPNext DB load
├── WebSocket compression ......... Lower bandwidth usage
└── Multi-reader support .......... Parallel reader handling
```

---

## LICENSE

```
MIT License

Copyright (c) 2025 Abdulfattox Qurbonov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## SUPPORT & CONTRIBUTIONS

```
Issue Reporting:
Platform: GitHub Issues
URL: https://github.com/WIKKIwk/ERPNext_UHFReader288_integration/issues

Required Information:
├── Hardware: Reader model and firmware version
├── OS: Operating system and version
├── Java: JRE/JDK version
├── Node.js: Runtime version
├── ERPNext: Version number
├── Error logs: Full stack traces
└── USB Device ID: lsusb output

Response SLA:
├── Hardware issues: 48 hours
├── Software bugs: 72 hours
└── Feature requests: Best effort

Pull Requests:
- Test on actual hardware before submitting
- Include documentation updates
- Follow existing code style
- Add comments for hardware-specific logic
```

---

```
PROJECT: UHF RFID Reader Integration for ERPNext
HARDWARE: ST-8504 / UHFReader288
VERSION: 1.0.0
LAST_UPDATED: 2025-12-26
MAINTAINER: Abdulfattox Qurbonov
PROTOCOL: UHF Gen2 (ISO 18000-6C)
STATUS: PRODUCTION_READY
```
## License

MIT License

Copyright (c) 2025 Wikki

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction...


**END DOCUMENTATION**
