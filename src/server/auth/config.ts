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
    return true;
  }

  return Boolean(email && allowedEmails.includes(email.toLowerCase()));
}
