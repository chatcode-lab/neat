import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";

import { adoptGoogleEmail } from "./db/accounts.server";
import { newId } from "./ids";
import { SESSION_SECONDS } from "./sessions.server";

const SESSION_REFRESH_SECONDS = 24 * 3600;

/** Only an email Google has verified is accepted for a new account. */
function requireVerifiedEmail(user: { email?: string | null; emailVerified?: boolean | null }) {
  if (!user.email || user.emailVerified !== true) {
    throw APIError.from("FORBIDDEN", { code: "email_not_verified", message: "The Google account's email is not verified." });
  }
}

/** Provider tokens are never kept: the site needs only who signed in. */
function withoutTokens<T extends Record<string, unknown>>(account: T): T {
  return { ...account, accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null };
}

/** The verified email inside a Google ID token, which came straight from Google over TLS. */
function googleEmail(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const payload = JSON.parse(atob(idToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as {
      email?: unknown;
      email_verified?: unknown;
    };
    return typeof payload.email === "string" && payload.email_verified === true ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

function createAuth(origin: string) {
  // A Google email seen while linking, for the hook after the link is written.
  // The instance serves one request only, so this is never shared.
  let linkedEmail: string | null = null;
  return betterAuth({
    appName: "neat.link",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    telemetry: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Lets someone with several Google accounts pick the right one.
        prompt: "select_account",
      },
    },
    session: {
      expiresIn: SESSION_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
      // Every request reads the session from D1, so signing out takes effect at once.
      cookieCache: { enabled: false },
    },
    account: {
      updateAccountOnSignIn: false,
      // Google is linked to an account made with Telegram only on purpose,
      // from Settings: never by a matching email at sign-in. Its name and
      // picture then replace Telegram's.
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
        allowDifferentEmails: true,
        disableImplicitLinking: true,
        updateUserInfoOnLink: true,
      },
    },
    advanced: {
      useSecureCookies: origin.startsWith("https:"),
      database: { generateId: () => newId() },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            requireVerifiedEmail(user);
            return { data: { ...user, email: user.email.toLowerCase() } };
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            if (account.providerId === "google") linkedEmail = googleEmail(account.idToken);
            return { data: withoutTokens(account) };
          },
          // An account that had only Telegram takes the Google email it now has.
          after: async (account) => {
            if (account.providerId === "google" && linkedEmail) {
              await adoptGoogleEmail(env.DB, account.userId, linkedEmail, Math.floor(Date.now() / 1000));
            }
          },
        },
        update: { before: async (account) => ({ data: withoutTokens(account) }) },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth for one request. A new instance each time: an instance keeps
 * promises made while serving the request that created it, and Workers
 * refuse to let another request use them. The request's origin is the
 * site's, so callbacks match the address the visitor is on.
 */
export function authFor(request: Request): Auth {
  return createAuth(new URL(request.url).origin);
}

/** Moves Set-Cookie headers from Better Auth's answer onto a redirect. */
function redirectWithCookies(url: string, from: Response): Response {
  const headers = new Headers({ Location: url });
  for (const cookie of from.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/** Continue with Google: signs in, or makes the account. */
export async function googleSignIn(request: Request, next: string): Promise<Response | null> {
  const response = await authFor(request).api.signInSocial({
    body: {
      provider: "google",
      callbackURL: next,
      newUserCallbackURL: "/app?welcome=1",
      errorCallbackURL: `/signin?${new URLSearchParams({ next })}`,
      disableRedirect: true,
    },
    headers: request.headers,
    asResponse: true,
  });
  if (!response.ok) return null;
  const { url } = (await response.json()) as { url: string };
  return redirectWithCookies(url, response);
}

/** Links Google to the signed-in account, from Settings. */
export async function linkGoogle(request: Request): Promise<Response | null> {
  const response = await authFor(request).api.linkSocialAccount({
    body: {
      provider: "google",
      callbackURL: "/app/settings?linked=google",
      errorCallbackURL: "/app/settings",
      disableRedirect: true,
    },
    headers: request.headers,
    asResponse: true,
  });
  if (!response.ok) return null;
  const { url } = (await response.json()) as { url: string };
  return redirectWithCookies(url, response);
}
