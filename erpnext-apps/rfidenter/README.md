### RFIDenter

RFID reader realtime integration

### Quick start (ERPNext)

1) Ensure the app is installed on your site:

```bash
cd $PATH_TO_YOUR_BENCH
bench --site erp.localhost list-apps
```

2) Run migrations/build after updates:

```bash
cd $PATH_TO_YOUR_BENCH
bench --site erp.localhost migrate
bench build --app rfidenter
```

3) Open RFIDenter:

- `http://127.0.0.1:8000/app/rfidenter`
- Token: `http://127.0.0.1:8000/app/rfidenter-auth`
- Read (unique EPC+ANT): `http://127.0.0.1:8000/app/rfidenter-antenna`

### Node → ERP realtime push

RFIDenter exposes these API methods:

- `GET /api/method/rfidenter.rfidenter.api.ping`
- `POST /api/method/rfidenter.rfidenter.api.ingest_tags`
- `POST /api/method/rfidenter.rfidenter.api.register_agent`

To enable pushing tag data from the Node RFID service to ERPNext, set:

```bash
export ERP_PUSH_URL="http://127.0.0.1:8000"
```

Recommended: also set `ERP_PUSH_AUTH` (API key) from `/app/rfidenter-auth`.

Optional security (recommended if Node runs on a different machine):

1) Set token in ERPNext site config:

```bash
bench --site erp.localhost set-config rfidenter_token "YOUR_SECRET"
```

2) Set token for Node:

```bash
export RFIDENTER_TOKEN="YOUR_SECRET"
```

### Dedup (production)

ERP tomonda default dedup yoqilgan: **bitta EPC bitta antennada 1 marta**.

Config:

- `rfidenter_dedup_by_ant` (default: `true`)
- `rfidenter_dedup_ttl_sec` (default: `86400`)

### Installation

You can install this app using the [bench](https://github.com/frappe/bench) CLI:

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app $URL_OF_THIS_REPO
bench --site erp.localhost install-app rfidenter
```

If you downloaded a folder (offline/zip), copy `rfidenter/` into your bench `apps/` then run:

```bash
cd $PATH_TO_YOUR_BENCH
bench --site erp.localhost install-app rfidenter
bench --site erp.localhost migrate
bench build --app rfidenter
```

### Contributing

This app uses `pre-commit` for code formatting and linting. Please [install pre-commit](https://pre-commit.com/#installation) and enable it for this repository:

```bash
cd apps/rfidenter
pre-commit install
```

Pre-commit is configured to use the following tools for checking and formatting your code:

- ruff
- eslint
- prettier
- pyupgrade

### License

mit
