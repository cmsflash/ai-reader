export function extensionCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";

  return origin.startsWith("chrome-extension://")
    ? {
        "access-control-allow-origin": origin,
        vary: "origin",
      }
    : {};
}
