import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config({ path: ".env.local", override: false });
dotenv.config({ path: ".env", override: false });

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url:
      process.env.DIRECT_URL ||
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@localhost:5432/phosmith_gpt?schema=public",
  },
});
