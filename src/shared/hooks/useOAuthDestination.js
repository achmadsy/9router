"use client";

import { useCallback } from "react";

export default function useOAuthDestination(targetProviderId) {
  return useCallback((url) => {
    if (!targetProviderId) return url;
    const value = String(url);
    return `${value}${value.includes("?") ? "&" : "?"}as=${encodeURIComponent(targetProviderId)}`;
  }, [targetProviderId]);
}
