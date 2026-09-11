import { NextResponse } from "next/server";
import { requireAppUser } from "@/server/auth/access";
export async function POST() {
  const auth = await requireAppUser();
  if (auth.response) return auth.response;
  return NextResponse.json({ error: "Audio is generated on demand. Press Play on an article." }, { status: 410 });
}
