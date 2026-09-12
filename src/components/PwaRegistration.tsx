"use client";

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register(`/sw.js?v=${process.env.NEXT_PUBLIC_OFFLINE_VERSION ?? "1"}`, { updateViaCache: "none" }).catch(() => undefined);
    }
  }, []);

  return null;
}
