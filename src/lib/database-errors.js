export const DATABASE_UNCONFIGURED_CODE = "DATABASE_UNCONFIGURED";

export class DatabaseUnconfiguredError extends Error {
  constructor() {
    super("Neon DATABASE_URL is not configured yet. Add it to .env.local or your Vercel environment to enable saved projects.");
    this.name = "DatabaseUnconfiguredError";
    this.code = DATABASE_UNCONFIGURED_CODE;
    this.status = 503;
    this.setupRequired = true;
  }
}

export const isDatabaseSetupError = (error) =>
  Boolean(error?.setupRequired || error?.code === DATABASE_UNCONFIGURED_CODE);
