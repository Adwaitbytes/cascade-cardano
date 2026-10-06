"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError, ConductorOfflineError } from "@/lib/api/source";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            // An offline Conductor is checked again every 10 s, so the page recovers when it answers.
            refetchInterval: (query) => (query.state.error instanceof ConductorOfflineError ? 10_000 : false),
            retry: (count, error) => !(error instanceof ConductorOfflineError) && !(error instanceof ApiError && error.status !== null && error.status < 500) && count < 2,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
