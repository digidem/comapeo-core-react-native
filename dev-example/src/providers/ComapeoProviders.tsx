import { comapeo } from '@comapeo/core-react-native';
import { ComapeoCoreProvider } from '@comapeo/core-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { useState } from 'react';

// TODO: comapeo-core-react-native does not yet bundle a map server.
// Stubbed for now — map-style/icon/tile/map-share hooks will fail at runtime
// until a real map server is wired up. Everything else (projects, observations,
// tracks, presets, fields, members, invites, sync, device info) works.
const getMapServerBaseUrl = async () => new URL('http://127.0.0.1:0/');

export function ComapeoProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The doc/list queries fan out to native IPC; cache liberally.
            staleTime: 1000 * 30,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ComapeoCoreProvider
        clientApi={comapeo}
        queryClient={queryClient}
        getMapServerBaseUrl={getMapServerBaseUrl}
      >
        {children}
      </ComapeoCoreProvider>
    </QueryClientProvider>
  );
}
