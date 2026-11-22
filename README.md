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
| Pumps | `GET /api/pumps`, `GET /api/pumps/:id`, `POST /api/pumps/:id/start`, `/stop`, `PUT /api/pumps/:id/mode` |
| Water usage | `GET /api/usage/daily`, `/monthly`, `/statistics` |
| Logs and alerts | `GET /api/pump-logs?days=1`, `GET /api/alerts`, `PUT /api/alerts/:id/acknowledge` |
| Settings | `GET /api/settings`, `PUT /api/settings` |
| Sensor ingestion | `POST /api/sensors/readings` |

Pump start/stop requests require a reason and are rejected when the pump is offline, faulted (start), not in manual mode, or emergency stop is active (start). Automatic-mode pumps are evaluated against the configured auto-start/auto-stop thresholds after each sensor reading.

## Sensor payload and water calculation

Post a reading to `/api/sensors/readings`:

```json
{
  "tankId": "64a000000000000000000101",
  "waterLevel": 18000,
  "flowRate": 24.5,
  "leakDetected": false,
  "source": "DEVICE"
}
```

When a prior reading exists for that tank, usage for the interval is calculated using the mean of the two flow rates multiplied by elapsed minutes. The resulting liters are added to the building's UTC daily summary with an upsert on `(date, buildingId)`, so the daily record is not duplicated. Cost is `liters / 1000 * waterPricePerM3`. For real hardware, place sensor ingestion and pump controls behind authentication and network access controls before deployment; this starter API is intended for a trusted development environment.

## Validation

```powershell
# backend\
npm test
npm run build

# frontend\
npm test -- --watchAll=false
npm run build
```

