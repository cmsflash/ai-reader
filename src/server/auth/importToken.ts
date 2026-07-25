import { createHash, timingSafeEqual } from "node:crypto";
import { getAllowedEmails } from "@/server/auth/config";

export type ImportTokenUser = {
  email: string;
};

export function importTokenConfigured() {
  return Boolean(
    process.env.AI_READER_IMPORT_TOKEN && importTokenOwnerEmail(),
  );
}

export function requireImportToken(request: Request): ImportTokenUser | null {
  const configuredToken = process.env.AI_READER_IMPORT_TOKEN;
  const ownerEmail = importTokenOwnerEmail();
  const header = request.headers.get("authorization") ?? "";
  const suppliedToken = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!configuredToken || !ownerEmail || !suppliedToken) {
    return null;
  }

  const expected = createHash("sha256").update(configuredToken).digest();
  const supplied = createHash("sha256").update(suppliedToken).digest();

  return timingSafeEqual(expected, supplied) ? { email: ownerEmail } : null;
}

function importTokenOwnerEmail() {
  return (
    process.env.AI_READER_IMPORT_OWNER_EMAIL?.trim().toLowerCase() ??
    getAllowedEmails()[0]
  );
}
