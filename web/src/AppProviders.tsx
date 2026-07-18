import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ephemeralSandboxTheme } from "@/theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
});

/**
 * The sole application Mantine boundary.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <MantineProvider forceColorScheme="light" theme={ephemeralSandboxTheme}>
      <Notifications position="bottom-right" limit={4} />
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </MantineProvider>
  );
}
