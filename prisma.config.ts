import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// `prisma generate` (run by `npm run build`, e.g. on Vercel) never connects to the database, so a
// missing DATABASE_URL must not fail the build. Commands that do connect (migrate, seed) still need
// the real value; with the placeholder they fail with a connection error.
const BUILD_PLACEHOLDER_URL = 'postgresql://build:build@localhost:5432/build';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL || BUILD_PLACEHOLDER_URL,
  },
});
