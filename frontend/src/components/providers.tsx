'use client';

// ============================================================
// CodeMorph — Client Providers
// Wraps the app with all context providers that need
// 'use client': QueryClient, themes, etc.
// ============================================================
import type React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }): React.JSX.Element {
  // One QueryClient per browser session — stable across renders
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime:          60 * 1000,  // 1 min
            retry:              1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
