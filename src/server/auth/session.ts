export const sessionCookieName = "ai_reader_session";
export const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;

type AuthConfig = {
  enabled: boolean;
  configured: boolean;
  username: string;
  password: string;
  sessionSecret: string;
};

type SessionPayload = {
  sub: string;
  exp: number;
  v: 1;
};

export function getAuthConfig(): AuthConfig {
  const username = process.env.AI_READER_AUTH_USERNAME || "reader";
  const password = process.env.AI_READER_AUTH_PASSWORD || "";
  const sessionSecret = process.env.AI_READER_SESSION_SECRET || "";
  const enabled =
    Boolean(password || sessionSecret) ||
    process.env.VERCEL === "1" ||
    process.env.NODE_ENV === "production";

  return {
    enabled,
    configured: Boolean(password && sessionSecret),
    username,
    password,
    sessionSecret,
  };
}

export async function createSessionToken(username: string) {
  const config = getAuthConfig();

  if (!config.configured) {
    throw new Error("Authentication is not configured.");
  }

  const payload: SessionPayload = {
    sub: username,
    exp: Math.floor(Date.now() / 1000) + sessionMaxAgeSeconds,
    v: 1,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await sign(encodedPayload, config.sessionSecret);

  return `${encodedPayload}.${signature}`;
}

export async function verifySessionToken(token: string | undefined) {
  const config = getAuthConfig();

  if (!token || !config.configured) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = await sign(encodedPayload, config.sessionSecret);

  if (!constantTimeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<SessionPayload>;

    if (payload.v !== 1 || typeof payload.sub !== "string" || typeof payload.exp !== "number") {
      return null;
    }

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload.sub;
  } catch {
    return null;
  }
}

export async function verifyCredentials(username: string, password: string) {
  const config = getAuthConfig();

  if (!config.configured) {
    return false;
  }

  return (
    constantTimeEqual(username, config.username) && constantTimeEqual(password, config.password)
  );
}

async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string) {
  const maxLength = Math.max(left.length, right.length);
  let mismatch = left.length === right.length ? 0 : 1;

  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return mismatch === 0;
}

function base64UrlEncode(value: string) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}
