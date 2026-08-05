import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const rawTitle = formValue(form.get("title"));
    const rawText = formValue(form.get("text"));
    const rawUrl = formValue(form.get("url"));
    const articleUrl = firstArticleUrl(rawUrl, rawText, rawTitle);
    const destination = new URL("/share", request.url);

    if (!articleUrl) {
      destination.searchParams.set(
        "error",
        "The shared item did not contain an HTTP or HTTPS article URL.",
      );
      return NextResponse.redirect(destination, 303);
    }

    destination.searchParams.set("url", articleUrl);
    destination.searchParams.set("source", "android-share");

    if (rawTitle && rawTitle !== articleUrl) {
      destination.searchParams.set("title", rawTitle.slice(0, 240));
    }

    return NextResponse.redirect(destination, 303);
  } catch {
    const destination = new URL("/share", request.url);
    destination.searchParams.set("error", "Could not read the shared item.");
    return NextResponse.redirect(destination, 303);
  }
}

function firstArticleUrl(...values: string[]) {
  for (const value of values) {
    const candidates = value.match(/https?:\/\/[^\s<>"']+/gi) ?? [];

    for (const candidate of candidates) {
      try {
        const url = new URL(candidate.replace(/[),.;!?]+$/, ""));

        if (url.protocol === "http:" || url.protocol === "https:") {
          return url.href;
        }
      } catch {
        // Continue to the next candidate.
      }
    }
  }

  return null;
}

function formValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim().slice(0, 8_000) : "";
}
