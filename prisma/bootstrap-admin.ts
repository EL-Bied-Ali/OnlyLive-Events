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

  const existing = await prisma.adminUser.findUnique({ where: { email: parsed.data.email } });
  if (existing && (existing.role !== "super_admin" || !existing.isActive)) {
    throw new Error(
      `An AdminUser already exists for ${parsed.data.email} with role=${existing.role}, ` +
        `isActive=${existing.isActive}. Refusing to silently change its role or reactivate it — ` +
        "this script only rotates the password of an already-active super_admin, or creates a " +
        "new one. Use a distinct email, or change the role/active status deliberately first.",
    );
  }

  const passwordHash = await hashPassword(parsed.data.password);
  if (existing) {
    await prisma.adminUser.update({ where: { email: parsed.data.email }, data: { passwordHash } });
  } else {
    await prisma.adminUser.create({
      data: {
        email: parsed.data.email,
        passwordHash,
        name: "OnlyLive Admin",
        role: "super_admin",
      },
    });
  }
  console.log(`Admin user ensured (${parsed.data.email}). Credentials are not printed.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
