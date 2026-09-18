import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set – skipping admin seed');
    return;
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    if (await prisma.user.findUnique({ where: { email } })) {
      console.log(`Admin ${email} already exists`);
      return;
    }
    await prisma.user.create({
      data: {
        email,
        name: process.env.SEED_ADMIN_NAME ?? 'Administrator',
        role: Role.ADMIN,
        passwordHash: await bcrypt.hash(password, 10),
      },
    });
    console.log(`Created admin ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
