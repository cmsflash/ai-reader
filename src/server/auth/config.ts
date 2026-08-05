export function isClerkConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
}

export function shouldBypassAuthLocally() {
  return !isClerkConfigured() && process.env.NODE_ENV !== "production" && process.env.VERCEL !== "1";
}

export function getAllowedEmails() {
  return (process.env.AI_READER_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isEmailAllowed(email: string | null | undefined) {
  const allowedEmails = getAllowedEmails();

  if (allowedEmails.length === 0) {
    return false;
  }

  return Boolean(email && allowedEmails.includes(normalizeEmail(email)));
}

export function getIntegrationOwnerEmail() {
  const configured =
    process.env.AI_READER_INTEGRATION_OWNER_EMAIL?.trim() ||
    process.env.AI_READER_IMPORT_OWNER_EMAIL?.trim();
  return configured ? normalizeEmail(configured) : null;
}

export function isIntegrationOwner(email: string | null | undefined) {
  const ownerEmail = getIntegrationOwnerEmail();
  return Boolean(ownerEmail && email && ownerEmail === normalizeEmail(email));
}

export type PreviewTestOwnerResolution =
  | {
      isConfiguredDelegate: false;
      ownerEmail: null;
    }
  | {
      isConfiguredDelegate: true;
      ownerEmail: string | null;
    };

export function resolvePreviewTestOwnerEmail(
  userId: string | null | undefined,
  verifiedEmail: string | null | undefined,
): PreviewTestOwnerResolution {
  const previewTestUserId = process.env.AI_READER_PREVIEW_TEST_USER_ID?.trim();

  if (!previewTestUserId || !userId || userId !== previewTestUserId) {
    return {
      isConfiguredDelegate: false,
      ownerEmail: null,
    };
  }

  if (process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "preview") {
    return {
      isConfiguredDelegate: true,
      ownerEmail: null,
    };
  }

  const importOwnerEmail = explicitOwnerEmail(
    process.env.AI_READER_IMPORT_OWNER_EMAIL,
  );
  const integrationOwnerEmail = explicitOwnerEmail(
    process.env.AI_READER_INTEGRATION_OWNER_EMAIL,
  );

  if (
    !importOwnerEmail ||
    !integrationOwnerEmail ||
    importOwnerEmail !== integrationOwnerEmail ||
    !isEmailAllowed(importOwnerEmail) ||
    !isEmailAllowed(verifiedEmail)
  ) {
    return {
      isConfiguredDelegate: true,
      ownerEmail: null,
    };
  }

  return {
    isConfiguredDelegate: true,
    ownerEmail: importOwnerEmail,
  };
}

export function selectVerifiedAllowedEmail(
  emailAddresses: ReadonlyArray<{
    id: string;
    emailAddress: string;
    verification?: {
      status?: string | null;
    } | null;
  }>,
  primaryEmailAddressId?: string | null,
) {
  const verified = emailAddresses.filter(
    (email) => email.verification?.status === "verified",
  );
  const primary = verified.find(
    (email) => email.id === primaryEmailAddressId,
  );
  const ordered = [
    primary,
    ...verified.filter((email) => email.id !== primary?.id),
  ].filter((email): email is NonNullable<typeof email> => Boolean(email));

  return (
    ordered.find((email) => isEmailAllowed(email.emailAddress))?.emailAddress ??
    ordered[0]?.emailAddress
  );
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function explicitOwnerEmail(email: string | null | undefined) {
  const configured = email?.trim();
  return configured ? normalizeEmail(configured) : null;
}
