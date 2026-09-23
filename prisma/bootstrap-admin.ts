import "dotenv/config";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";

// Admin-only bootstrap: creates/updates exactly one super_admin AdminUser
// row and touches nothing else. Unlike `prisma/seed.ts`, this never
// creates/upserts the demo venue, event, categories, inventory or sales
// phases — safe to run against a real (including production) database
// that must not receive demo catalogue data. See
// docs/SECURITY.md's "Admin bootstrap and password rotation" section.
const adminSeedSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  // Deliberately higher than the customer minimum (10) — this account
  // has super_admin privileges.
  password: z.string().min(16).max(200),
});

async function main() {
  const rawEmail = process.env.ADMIN_SEED_EMAIL;
  const rawPassword = process.env.ADMIN_SEED_PASSWORD;

  if (!rawEmail || !rawPassword) {
    throw new Error(
      "Both ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD must be set to bootstrap an admin.",
    );
  }

  const parsed = adminSeedSchema.safeParse({ email: rawEmail, password: rawPassword });
  if (!parsed.success) {
    throw new Error(
      `Invalid ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await prisma.adminUser.upsert({
    where: { email: parsed.data.email },
    update: { passwordHash },
    create: {
      email: parsed.data.email,
      passwordHash,
      name: "OnlyLive Admin",
      role: "super_admin",
    },
  });
  console.log(`Admin user ensured (${parsed.data.email}). Credentials are not printed.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
