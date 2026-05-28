import { DatabaseUnconfiguredError } from "@/lib/database-errors";

let prisma;

export const isDatabaseConfigured = () => Boolean(process.env.DATABASE_URL?.trim());

export const getPrisma = async () => {
  if (!isDatabaseConfigured()) return null;
  if (prisma) return prisma;

  const { PrismaClient } = await import("@prisma/client");
  const { PrismaNeon } = await import("@prisma/adapter-neon");
  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL,
  });
  prisma = globalThis.__pixxelPrisma || new PrismaClient({ adapter });

  if (process.env.NODE_ENV !== "production") {
    globalThis.__pixxelPrisma = prisma;
  }

  return prisma;
};

export const requirePrisma = async () => {
  const db = await getPrisma();
  if (!db) throw new DatabaseUnconfiguredError();
  return db;
};
