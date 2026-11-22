# AquaSync Campus Water Management

A responsive university water dashboard with a React/TypeScript frontend and an Express/TypeScript API. MongoDB persistence is handled through Prisma. The dashboard reads backend data; development samples are inserted only by the explicit seed command and sensor samples are tagged `MOCK`.

## Project layout

```text
wecon-dashboard/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma       # MongoDB collections and ObjectId models
│   │   └── seed.ts             # Explicit development-only sample data
│   ├── src/
│   │   ├── server.ts           # REST API, validation, pump interlocks, sensor ingestion
│   │   ├── deviceTelemetry.ts  # Validated HTTP payload contract for gateway telemetry
│   │   ├── deviceTelemetry.test.ts
│   │   ├── waterUsage.ts       # Flow-rate interval integration
│   │   └── waterUsage.test.ts  # Usage calculation tests
│   ├── .env.example
│   └── package.json
└── frontend/
    ├── public/
    ├── src/
    │   ├── api.ts              # Typed API client and response models
    │   ├── App.tsx             # Overview, pump operation, settings and map views
    │   ├── App.css             # Responsive dashboard styles and Tailwind entry points
    │   └── index.tsx
    ├── craco.config.js         # Tailwind PostCSS integration
    ├── tailwind.config.js
    └── package.json
```

## Requirements

- Node.js 20 LTS or later and npm
- MongoDB Atlas, or a local MongoDB replica set

Prisma's MongoDB connector expects a replica set, including for a local development database. A standalone local `mongod` is not sufficient.

## MongoDB setup

### Option A: MongoDB Atlas

1. Create a MongoDB cluster and a database user.
2. Allow your development machine's IP in the cluster network access list.
3. Copy the cluster connection string. Replace the password and database name, URL-encoding special characters in the username/password.
4. Put the URI in `backend\.env` as `DATABASE_URL`. Keep credentials private and do not commit `.env`.

### Option B: Local replica set on Windows

Create a data directory, then run MongoDB with replica set mode in one terminal:

```powershell
New-Item -ItemType Directory -Force C:\data\db
mongod --replSet rs0 --dbpath C:\data\db
```

In another terminal, initialize the replica set once:

```powershell
mongosh --eval "rs.initiate()"
```

Use this connection string in `backend\.env`:

```text
DATABASE_URL="mongodb://127.0.0.1:27017/water_management?replicaSet=rs0"
```

## Install and configure

From the project directory, create the backend environment file and set `DATABASE_URL` to your own MongoDB URI:

```powershell
Copy-Item backend\.env.example backend\.env
```

Install backend packages, generate the Prisma Client, and create/update the MongoDB collections and indexes:

```powershell
Set-Location backend
npm install
npm run db:generate
npm run db:push
```

To load the optional sample buildings, tanks, pumps, history, alerts, and readings:

```powershell
npm run db:seed
```

The seed command skips an already-populated database. Its generated sensor readings are explicitly tagged `MOCK`; do not run it against a production database.

Install frontend packages in a second terminal:

```powershell
Set-Location frontend
npm install
```

The frontend defaults to `http://localhost:4000/api`. To change it, create `frontend\.env.local`:

```text
REACT_APP_API_URL=http://localhost:4000/api
```

Set `CLIENT_ORIGIN` in `backend\.env` to the frontend origin if it differs from `http://localhost:3000`.
Set `DEVICE_INGEST_TOKEN` to a long random secret (at least 32 characters) shared only with the trusted PLC/Gateway. Device endpoints reject requests when this token is not configured.

## Run the application

Start the backend from `backend\`:

```powershell
npm run dev
```

Start the frontend from `frontend\` in another terminal:

```powershell
npm start
```

Open `http://localhost:3000`. The API health check is at `http://localhost:4000/api/health`. MongoDB must be reachable for dashboard API calls to return data.

For a production build:

```powershell
# backend\
npm run build
npm start

# frontend\ (in a separate terminal)
npm run build
```

## API overview

All responses are JSON. Request bodies are validated; malformed ids and invalid data return 400, missing records return 404, and unsafe pump commands return 409.

| Area | Routes |
|---|---|
| Dashboard | `GET /api/dashboard/overview`, `/water-usage?range=24h\|7d\|30d\|12m`, `/water-cost`, `/recent-events` |
| Buildings | `GET /api/buildings`, `GET /api/buildings/:id`, `GET /api/buildings/:id/usage?days=30` |
| Tanks | `GET /api/tanks`, `GET /api/tanks/:id`, `POST /api/tanks`, `PUT /api/tanks/:id` |
| Flow meters | `GET /api/flow-meters`, `POST /api/flow-meters` |
| Pumps | `GET /api/pumps`, `GET /api/pumps/:id`, `POST /api/pumps/:id/start`, `/stop`, `PUT /api/pumps/:id/mode` |
| Water usage | `GET /api/usage/daily`, `/monthly`, `/statistics` |
| Logs and alerts | `GET /api/pump-logs?days=1`, `GET /api/alerts`, `PUT /api/alerts/:id/acknowledge` |
| Settings | `GET /api/settings`, `PUT /api/settings` |
| Device ingestion (HTTP; no MQTT broker/subscriber included) | `POST /api/device-telemetry`, `POST /api/sensors/readings` |

Pump start/stop requests require a reason and are rejected when the pump is offline, faulted (start), not in manual mode, or emergency stop is active (start). Automatic-mode pumps are evaluated against the configured auto-start/auto-stop thresholds after each sensor reading.

## Device telemetry ingestion

Post a gateway snapshot to `/api/device-telemetry`. The request must include `Authorization: Bearer <DEVICE_INGEST_TOKEN>`. Map registered tanks by MongoDB `tankId` and pumps by `pumpCode`. A successful request returns HTTP 202 and the number of accepted tank and pump readings.

```json
{
  "deviceId": "campus-gateway-1",
  "recordedAt": "2026-11-22T11:00:00Z",
  "tanks": [
    {
      "tankId": "64a000000000000000000101",
      "waterLevelLiter": 18000,
      "pressureKpa": 42.5,
      "lowLevelSwitch": false,
      "highLevelSwitch": false,
      "leakDetected": false
    }
  ],
  "flowMeters": [
    {
      "meterCode": "FM-MB-IN",
      "flowRateLpm": 24.5,
      "totalizerLiter": 283410
    }
  ],
  "pumps": [
    {
      "pumpCode": "P-MB1",
      "running": true,
      "fault": false,
      "faultCode": "OK",
      "overcurrentDetected": false,
      "flowRateLpm": 24.5,
      "currentA": 3.2,
      "voltageV": 230,
      "powerFactor": 0.91,
      "activePowerKw": 0.68,
      "energyKwh": 152.7
    }
  ]
}
```

`tanks` and `pumps` can be sent independently or together. Each array entry must identify an already registered tank or pump. `recordedAt` is optional and defaults to the server time. The gateway must send a single combined entry per tank in a packet and use increasing timestamps for each device/tank stream.

Register each flow meter once using `POST /api/flow-meters` with its building id, code, and name:

```json
{
  "buildingId": "64a000000000000000000001",
  "meterCode": "FM-MB-IN",
  "meterName": "Main Building inlet meter"
}
```

The building meter is then identified in device packets by `meterCode`. Use one billing meter per building supply; do not report the same physical water flow through both a tank sensor and a building meter.

- Tank `waterLevelLiter`: calibrated water volume, used to update tank level and threshold status. `pressureKpa` is also stored as the raw pressure reading; the API does not infer liters from pressure because tank geometry and sensor mounting offset are site-specific.
- `lowLevelSwitch` / `highLevelSwitch`: float-switch states.
- `leakDetected`: leak signal from an external detector or gateway rule. The API records a leak alert when `true`; it does not infer leaks from flow patterns yet.

Flow meter fields:

- `flowRateLpm` and/or cumulative `totalizerLiter`. When consecutive totalizer readings are available, daily usage is calculated from their difference; otherwise, consecutive flow-rate samples are integrated across their actual elapsed time. The building's daily summary is upserted, and monthly cost is refreshed.

Pump fields:

- `running` and `fault` update pump status (`ON`, `OFF`, `FAULT`) and create pump logs when status changes.
- `currentA`, `voltageV`, `powerFactor`, `activePowerKw`, and `energyKwh` update the latest pump values and are stored as historical `PumpReading` records.
- `overcurrentDetected` records an overcurrent alert from the motor protection relay/PLC. The API does not guess an overcurrent threshold from current readings.

Readings are validated before processing; unknown ids/codes, tank levels above capacity, stale timestamps, or a decreasing flow-meter totalizer are rejected. Device requests are protected by a bearer token. Use HTTPS and keep the token on the trusted gateway; do not expose device control or ingestion endpoints directly to the public internet.

The expected data path is sensor/PLC/Gateway → authenticated HTTP request → API validation and MongoDB storage. This is an HTTP ingestion endpoint only. A separate MQTT broker/subscriber can later translate MQTT messages to this JSON contract or call the same ingestion service; no MQTT dependency or subscriber is included here.

## Validation

```powershell
# backend\
npm test
npm run build

# frontend\
npm test -- --watchAll=false
npm run build
```

