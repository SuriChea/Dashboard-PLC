# Frontend

The React/TypeScript dashboard is part of the AquaSync Campus Water Management project. For MongoDB setup, Prisma generation, API configuration, and full run instructions, see the [project README](../README.md).

Available commands:

- `npm start` — run the frontend (CRACO + Tailwind) on port 3000.
- `npm test -- --watchAll=false` — run the frontend tests once.
- `npm run build` — create an optimized production build.

The API base URL defaults to `http://localhost:4000/api`; set `REACT_APP_API_URL` in `.env.local` to override it.
