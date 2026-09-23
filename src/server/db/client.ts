import "server-only";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getServerEnv } from "../env";

const databaseGlobal = globalThis as typeof globalThis & {
  yoriPrisma?: PrismaClient;
};

/**
 * One lazy client/pool per Node process, including development hot reloads.
 * Importing this module does not validate env or open a database connection.
 * Use only inside server services; never in client components or static layouts.
 */
export function getDb(): PrismaClient {
  if (!databaseGlobal.yoriPrisma) {
    const { DATABASE_URL } = getServerEnv("database");
    const url = new URL(DATABASE_URL);
    const schema = url.searchParams.get("schema") ?? "public";
    // `schema` is a Prisma option, not a node-postgres connection option.
    url.searchParams.delete("schema");
    const adapter = new PrismaPg(
      {
        connectionString: url.toString(),
        max: 5,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
      },
      { schema },
    );
    databaseGlobal.yoriPrisma = new PrismaClient({ adapter });
  }
  return databaseGlobal.yoriPrisma;
}
