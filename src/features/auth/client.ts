"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client. It talks to this application's own `/api/auth/*` route,
 * holds no secret (the session lives in an httpOnly cookie), and is the only
 * way auth UI in `src/features/auth` reaches the server.
 */
export const authClient = createAuthClient();

export type { Session, User } from "better-auth";
