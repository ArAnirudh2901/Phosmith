let prisma;

export const getPrisma = async () => {
  if (!process.env.DATABASE_URL) return null;
  if (prisma) return prisma;

  const { PrismaClient } = await import("@prisma/client");
  prisma = globalThis.__pixxelPrisma || new PrismaClient();

  if (process.env.NODE_ENV !== "production") {
    globalThis.__pixxelPrisma = prisma;
  }

  return prisma;
};
