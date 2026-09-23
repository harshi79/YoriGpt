import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";

// Resolved per request so the auth instance (and its environment) is never
// constructed while Next.js builds or prerenders routes.
const handlers = toNextJsHandler((request: Request) => getAuth().handler(request));

export const { GET, POST } = handlers;
