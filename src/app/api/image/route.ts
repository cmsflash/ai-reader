import { NextResponse } from "next/server";
import { imageFetchHeaders } from "@/server/artifacts/imageRequests";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const imageUrl = parseHttpUrl(requestUrl.searchParams.get("url"), "Image URL is required.");
    const sourceUrl = parseOptionalHttpUrl(requestUrl.searchParams.get("source"));

    const response = await fetch(imageUrl.href, {
      headers: imageFetchHeaders(imageUrl, sourceUrl),
      redirect: "follow",
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Could not fetch image: ${response.status} ${response.statusText}` },
        { status: response.status },
      );
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";

    if (!contentType.toLowerCase().startsWith("image/")) {
      return NextResponse.json({ error: "The requested URL did not return an image." }, { status: 415 });
    }

    return new Response(response.body, {
      headers: {
        "cache-control": "public, max-age=86400",
        "content-type": contentType,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not proxy image.",
      },
      { status: 400 },
    );
  }
}

function parseHttpUrl(value: string | null, errorMessage: string) {
  if (!value) {
    throw new Error(errorMessage);
  }

  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS image URLs are supported.");
  }

  return url;
}

function parseOptionalHttpUrl(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    return parseHttpUrl(value, "Invalid source URL.");
  } catch {
    return null;
  }
}
