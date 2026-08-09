import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type HostedBrowserSession = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  user: Record<string, unknown>;
};
export type HostedPublicSession = Omit<HostedBrowserSession, "refresh_token">;

function normalizeUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function decodeSessionKey(value: string) {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) throw new Error("CAREEROS_SESSION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

export function sealRefreshToken(refreshToken: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(refreshToken, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function openRefreshToken(value: string, key: Buffer) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("The hosted session cookie is invalid.");
  const payload = Buffer.from(value, "base64url");
  if (payload.toString("base64url") !== value) throw new Error("The hosted session cookie is invalid.");
  if (payload.length < 29) throw new Error("The hosted session cookie is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}

export class HostedSessionService {
  readonly enabled: boolean;
  readonly #supabaseUrl: string;
  readonly #anonKey: string;
  readonly #key: Buffer | null;
  readonly #fetch: typeof fetch;

  constructor(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
    const env = options.env ?? process.env;
    this.#supabaseUrl = normalizeUrl(env.SUPABASE_URL ?? "");
    this.#anonKey = env.SUPABASE_ANON_KEY?.trim() ?? "";
    this.enabled = env.CAREEROS_HOSTED === "1" || env.NODE_ENV === "production";
    const keyValue = env.CAREEROS_SESSION_ENCRYPTION_KEY?.trim() ?? "";
    if (this.enabled && !keyValue) throw new Error("Hosted CareerOS requires CAREEROS_SESSION_ENCRYPTION_KEY so sign-in survives refresh without browser storage.");
    if (this.enabled && (!this.#supabaseUrl || !this.#anonKey)) throw new Error("Hosted CareerOS requires SUPABASE_URL and SUPABASE_ANON_KEY for Google sessions.");
    if (this.enabled && new URL(this.#supabaseUrl).protocol !== "https:") throw new Error("Hosted CareerOS requires an HTTPS SUPABASE_URL.");
    this.#key = keyValue ? decodeSessionKey(keyValue) : null;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async rotate(refreshToken: string): Promise<HostedBrowserSession> {
    if (!this.enabled || !this.#key) throw Object.assign(new Error("Hosted sessions are not enabled."), { statusCode: 409 });
    if (!refreshToken || refreshToken.length < 20) throw Object.assign(new Error("The Google sign-in session is invalid."), { statusCode: 401 });
    const response = await this.#fetch(`${this.#supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: this.#anonKey, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) throw Object.assign(new Error("Your Google sign-in session expired. Sign in again."), { statusCode: 401 });
    const body = await response.json() as Partial<HostedBrowserSession>;
    if (!body.access_token || !body.refresh_token || !body.user || typeof body.expires_in !== "number") {
      throw Object.assign(new Error("The identity provider returned an incomplete session."), { statusCode: 502 });
    }
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      token_type: body.token_type ?? "bearer",
      expires_in: body.expires_in,
      expires_at: body.expires_at ?? Math.floor(Date.now() / 1_000) + body.expires_in,
      user: body.user,
    };
  }

  cookie(session: HostedBrowserSession, production: boolean) {
    return `careeros_session=${sealRefreshToken(session.refresh_token, this.#key!)}; Path=/api/auth/session; HttpOnly; SameSite=Strict; Max-Age=2592000${production ? "; Secure" : ""}`;
  }

  publicSession(session: HostedBrowserSession): HostedPublicSession {
    const { refresh_token: _refreshToken, ...publicSession } = session;
    return publicSession;
  }

  clearCookie(production: boolean) {
    return `careeros_session=; Path=/api/auth/session; HttpOnly; SameSite=Strict; Max-Age=0${production ? "; Secure" : ""}`;
  }

  refreshTokenFromCookie(cookieValue: string) {
    if (!this.#key) throw Object.assign(new Error("Hosted sessions are not enabled."), { statusCode: 409 });
    try { return openRefreshToken(cookieValue, this.#key); }
    catch { throw Object.assign(new Error("Your Google sign-in session is invalid. Sign in again."), { statusCode: 401 }); }
  }
}
