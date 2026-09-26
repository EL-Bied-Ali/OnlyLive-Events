import "dotenv/config";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";

const adminSeedSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  // Deliberately higher than the customer minimum (10) — this account
  // has super_admin privileges.
  password: z.string().min(16).max(200),
});

async function main() {
  const venue = await prisma.venue.upsert({
    where: { id: "venue-casablanca-arena" },
    update: {},
    create: {
      id: "venue-casablanca-arena",
      name: "Casablanca Arena",
      addressLine1: "Boulevard de la Corniche",
      city: "Casablanca",
      country: "MA",
      capacity: 15000,
    },
  });

  const event = await prisma.event.upsert({
    where: { slug: "tiakola-casablanca-2026" },
    update: { coverImageUrl: "/events/tiakola-casablanca-2026/poster.webp" },
    create: {
      slug: "tiakola-casablanca-2026",
      title: "Tiakola — Live à Casablanca",
      description:
        "Tiakola en concert exceptionnel à Casablanca. Une soirée live organisée par OnlyLive.",
      venueId: venue.id,
      startsAt: new Date("2026-12-05T20:00:00+01:00"),
      doorsOpenAt: new Date("2026-12-05T18:30:00+01:00"),
      salesOpenAt: new Date("2026-01-01T00:00:00+01:00"),
      salesCloseAt: new Date("2026-12-05T19:00:00+01:00"),
      status: "on_sale",
      coverImageUrl: "/events/tiakola-casablanca-2026/poster.webp",
    },
  });

  const categories = [
    { name: "VVIP", sortOrder: 0, totalQuantity: 200, earlyBirdPrice: 250000, phase1Price: 300000 },
    { name: "VIP", sortOrder: 1, totalQuantity: 800, earlyBirdPrice: 120000, phase1Price: 150000 },
    { name: "Gradins", sortOrder: 2, totalQuantity: 3000, earlyBirdPrice: 40000, phase1Price: 50000 },
  ];

  for (const category of categories) {
    const ticketCategory = await prisma.ticketCategory.upsert({
      where: { eventId_name: { eventId: event.id, name: category.name } },
      update: {},
      create: {
        eventId: event.id,
        name: category.name,
        sortOrder: category.sortOrder,
      },
    });

    await prisma.inventory.upsert({
      where: { ticketCategoryId: ticketCategory.id },
      update: {},
      create: {
        ticketCategoryId: ticketCategory.id,
        totalQuantity: category.totalQuantity,
      },
    });

    const existingPhases = await prisma.salesPhase.findMany({ where: { ticketCategoryId: ticketCategory.id } });
    if (existingPhases.length === 0) {
      await prisma.salesPhase.createMany({
        data: [
          {
            ticketCategoryId: ticketCategory.id,
            name: `${category.name} Early Bird`,
            priceCents: category.earlyBirdPrice,
            startsAt: new Date("2026-01-01T00:00:00+01:00"),
            endsAt: new Date("2026-06-01T00:00:00+01:00"),
            sortOrder: 0,
          },
          {
            ticketCategoryId: ticketCategory.id,
            name: `${category.name} Phase 1`,
            priceCents: category.phase1Price,
            startsAt: new Date("2026-06-01T00:00:00+01:00"),
            endsAt: null,
            sortOrder: 1,
          },
        ],
      });
    }
  }

  // No default admin is ever created silently. An initial admin account
  // is only seeded when ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD are
  // both explicitly provided — see docs/SECURITY.md for the bootstrap
  // and password-rotation procedure. Credentials are never printed.
  const rawEmail = process.env.ADMIN_SEED_EMAIL;
  const rawPassword = process.env.ADMIN_SEED_PASSWORD;

  if (!rawEmail && !rawPassword) {
    console.log("Seed: ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD not set — skipping admin user creation.");
  } else {
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
    console.log(`Seed: admin user ensured (${parsed.data.email}). Credentials are not printed.`);
  }

  console.log("Seed complete:");
  console.log(`  Event: ${event.title} (${event.slug})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
