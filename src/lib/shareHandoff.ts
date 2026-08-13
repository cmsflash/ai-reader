export const SHARE_RETURN_FALLBACK_DELAY_MS = 700;

type ShareHandoffTarget = {
  clearTimeout: (handle: number) => void;
  close: () => void;
  location: {
    replace: (url: string) => void;
  };
  setTimeout: (handler: () => void, delay: number) => number;
};

type ShareHandoffOptions = {
  fallbackDelayMs?: number;
  fallbackUrl?: string;
};

export function beginShareHandoff(
  target: ShareHandoffTarget,
  options: ShareHandoffOptions = {},
) {
  const fallbackUrl = options.fallbackUrl ?? "/";
  const fallbackDelayMs =
    options.fallbackDelayMs ?? SHARE_RETURN_FALLBACK_DELAY_MS;
  const fallbackHandle = target.setTimeout(() => {
    target.location.replace(fallbackUrl);
  }, fallbackDelayMs);

  try {
    target.close();
  } catch {
    target.clearTimeout(fallbackHandle);
    target.location.replace(fallbackUrl);
  }

  return () => target.clearTimeout(fallbackHandle);
}

export function shouldAutoReturnFromShare(
  source?: string,
  returnToSource?: string,
) {
  return source === "android-share" && returnToSource === "1";
}
