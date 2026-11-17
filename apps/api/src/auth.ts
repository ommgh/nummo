/**
 * Dashboard accounts with Better Auth (better-auth.com): email and password,
 * GitHub and Google when their credentials are set, and organizations with
 * members, roles and invitations. Served at /api/auth/*.
 *
 * A Better Auth organization is a nummo org: it is created with a nummo id
 * (org_…) and the orgs row with the same id is created alongside it, so API
 * keys, customers and plans hang off the organization people sign in to.
 *
 * Settings: BETTER_AUTH_SECRET (required in production, 32+ random bytes),
 * GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET, GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET,
 * NUMMO_TRUSTED_ORIGINS (comma-separated, extra origins allowed to call it).
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { type Db, ensureOrg, firstOrganization, newId, renameOrg, schema } from "@usenummo/db";

const ID_PREFIX: Record<string, string> = {
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "ver",
  organization: "org",
  member: "mem",
  invitation: "inv",
};

export function createAuth(db: Db, opts: { publicUrl: string; env?: NodeJS.ProcessEnv }) {
  const env = opts.env ?? process.env;
  const social: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) social.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) social.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  const trustedOrigins = [
    new URL(opts.publicUrl).origin,
    ...(env.NODE_ENV === "production" ? [] : ["http://localhost:5173"]),
    ...(env.NUMMO_TRUSTED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ];

  return betterAuth({
    appName: "nummo",
    baseURL: opts.publicUrl,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.authUsers,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
        organization: schema.authOrganizations,
        member: schema.authMembers,
        invitation: schema.authInvitations,
      },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: true },
    socialProviders: social,
    session: { expiresIn: 7 * 86_400, updateAge: 86_400 },
    advanced: {
      database: { generateId: ({ model }) => newId(ID_PREFIX[model] ?? model.slice(0, 3)) },
      cookiePrefix: "nummo",
    },
    databaseHooks: {
      session: {
        create: {
          // Sign straight in to the first organization the user belongs to.
          before: async (session) => ({ data: { ...session, activeOrganizationId: await firstOrganization(db, session.userId) } }),
        },
      },
    },
    plugins: [
      organization({
        organizationHooks: {
          afterCreateOrganization: async ({ organization: o }) => ensureOrg(db, o.id, o.name),
          afterUpdateOrganization: async ({ organization: o }) => {
            if (o) await renameOrg(db, o.id, o.name);
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
