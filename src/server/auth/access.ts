import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  getAllowedEmails,
  getIntegrationOwnerEmail,
  isClerkConfigured,
  isEmailAllowed,
  isIntegrationOwner,
  resolvePreviewTestOwnerEmail,
  selectVerifiedAllowedEmail,
  shouldBypassAuthLocally,
} from "@/server/auth/config";

export type AppAuthStatus = {
  enabled: boolean;
  configured: boolean;
  authenticated: boolean;
  authorized: boolean;
  allowlistConfigured: boolean;
  email?: string;
  userId?: string;
};

export type AppUser = {
  email: string;
  ownerEmail: string;
  userId?: string;
};

export type RequireAppUserResult =
  | {
      response: null;
      user: AppUser;
    }
  | {
      response: NextResponse;
      user: null;
    };

export async function getAppAuthStatus(): Promise<AppAuthStatus> {
  const allowlistConfigured = getAllowedEmails().length > 0;

  if (!isClerkConfigured()) {
    const localBypass = shouldBypassAuthLocally();

    return {
      enabled: !localBypass,
      configured: false,
      authenticated: localBypass,
      authorized: localBypass,
      allowlistConfigured,
    };
  }

  const user = await currentUser();

  if (!user) {
    return {
      enabled: true,
      configured: true,
      authenticated: false,
      authorized: false,
      allowlistConfigured,
    };
  }

  const email = selectVerifiedAllowedEmail(
    user.emailAddresses,
    user.primaryEmailAddressId,
  );
  const previewTestOwner = resolvePreviewTestOwnerEmail(user.id, email);
  const authorized = previewTestOwner.isConfiguredDelegate
    ? Boolean(previewTestOwner.ownerEmail)
    : isEmailAllowed(email);

  return {
    enabled: true,
    configured: true,
    authenticated: true,
    authorized,
    allowlistConfigured,
    email,
    userId: user.id,
  };
}

export async function requireAppUser(): Promise<RequireAppUserResult> {
  const status = await getAppAuthStatus();
  const response = responseForUnauthorizedStatus(status);

  if (response) {
    return { response, user: null };
  }

  const email = normalizeEmail(status.email ?? localDevelopmentOwnerEmail());
  const previewTestOwner = resolvePreviewTestOwnerEmail(status.userId, email);

  return {
    response: null,
    user: {
      email,
      ownerEmail: previewTestOwner.ownerEmail ?? email,
      userId: status.userId,
    },
  };
}

export async function requireAppUserResponse() {
  const status = await getAppAuthStatus();
  return responseForUnauthorizedStatus(status);
}

export function requireIntegrationOwnerResponse(email: string) {
  if (!getIntegrationOwnerEmail()) {
    return NextResponse.json(
      { error: "Provider integrations do not have a configured owner." },
      { status: 503 },
    );
  }

  if (!isIntegrationOwner(email)) {
    return NextResponse.json(
      { error: "Provider integrations are available only to their configured owner." },
      { status: 403 },
    );
  }

  return null;
}

function responseForUnauthorizedStatus(status: AppAuthStatus) {
  if (!status.enabled) {
    return null;
  }

  if (!status.configured) {
    return NextResponse.json(
      { error: "Authentication is not configured. Configure Clerk before using the hosted app." },
      { status: 503 },
    );
  }

  if (!status.authenticated) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  if (!status.authorized) {
    return NextResponse.json(
      { error: "This account is not allowed to use this AI Reader instance." },
      { status: 403 },
    );
  }

  return null;
}

function localDevelopmentOwnerEmail() {
  return process.env.AI_READER_ALLOWED_EMAILS?.split(",")[0]?.trim() || "local@ai-reader.invalid";
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}
