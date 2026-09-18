# Ejad Test Cases API

The backend for Ejad's test case tool: projects, modules, manual test cases, test runs with
instant-save results, Excel/CSV import and export, and reports. NestJS 10, Prisma 7, PostgreSQL 16.

The design spec and plans are in `docs/superpowers/`.

## Local development

```bash
cp .env.example .env
npm install
npm run db:up            # PostgreSQL via Docker: both dev and test databases on port 5442
npx prisma migrate dev
npm run db:seed          # creates SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
npm run start:dev        # http://localhost:3000/api — Swagger at /api/docs
```

### Native PostgreSQL alternative

If Docker isn't available, install PostgreSQL 16 to listen on port 5442 and create the two
databases with `psql`:

```bash
psql -h localhost -p 5442 -U postgres -c "CREATE DATABASE ejad_testcases;"
psql -h localhost -p 5442 -U postgres -c "CREATE DATABASE ejad_testcases_test;"
```

Then continue from `npx prisma migrate dev` above.

## Tests

```bash
npm test                 # unit tests
npm run test:e2e         # e2e tests against the test database (port 5442)
```

## Deploy (Dokploy)

Build the `Dockerfile`. On start, the container applies migrations, seeds the first admin (only if it
doesn't exist yet) and starts the API on port 3000.

| Variable | Example |
|---|---|
| `DATABASE_URL` | `postgresql://user:pass@postgres:5432/ejad_testcases` |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | long random strings |
| `CORS_ORIGIN` | `https://tests.ejad.example` (comma-separated for several) |
| `COOKIE_SECURE` | `true` behind HTTPS |
| `COOKIE_SAMESITE` | `lax` if web and API share a site, `none` if they are on different sites |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | first admin account |

Import previews are held in memory for 30 minutes, so run a **single** API container.
