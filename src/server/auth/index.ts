import "server-only";
import { createAuth } from "./config";

export type YoriAuth = ReturnType<typeof createAuth>;
export type AuthSession = YoriAuth["$Infer"]["Session"];
export type AuthUser = AuthSession["user"];

let cached: YoriAuth | undefined;

/**
 * One Better Auth instance per server process. Creating it reads the auth
 * environment and builds the Prisma adapter, so it stays lazy: no import of this
 * module (or of a page that renders session state) requires auth configuration
 * until a request actually asks for it.
 *
 * Cookie attributes, CSRF/origin validation, token lifetimes, and password
 * hashing all come from Better Auth; nothing is reimplemented here.
 */
export function getAuth(): YoriAuth {
  cached ??= createAuth();
  return cached;
}
