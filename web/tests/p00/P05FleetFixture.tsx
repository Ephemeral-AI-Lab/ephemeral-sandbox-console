import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, useParams } from "react-router";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "../../src/index.css";
import { ephemeralSandboxTheme } from "../../src/theme";
import { FleetBoard } from "../../src/pages/fleet/FleetBoard";
import { Shell } from "../../src/shell/Shell";

function SandboxRouteProbe() {
  const { sandboxId = "" } = useParams();

  return (
    <section aria-label="Sandbox detail fixture" data-fixture-sandbox-route>
      <h1>Sandbox detail</h1>
      <p data-fixture-sandbox-id>{sandboxId}</p>
    </section>
  );
}

function Fixture() {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
    [],
  );

  return (
    <MantineProvider forceColorScheme="light" theme={ephemeralSandboxTheme}>
      <Notifications limit={4} position="bottom-right" />
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename="/p05-fleet.html">
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<FleetBoard />} />
              <Route path="sandboxes/:sandboxId" element={<SandboxRouteProbe />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </MantineProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
