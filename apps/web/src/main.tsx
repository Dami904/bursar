import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { WagmiProvider } from "wagmi";
import { Shell } from "./components/Shell.js";
import { Docs } from "./docs/Docs.js";
import { SessionProvider, useSession } from "./lib/session.js";
import { wagmiConfig } from "./lib/wagmi.js";
import { Approvals } from "./pages/Approvals.js";
import { Demo, DemoEvidence } from "./pages/Demo.js";
import { EvidencePage } from "./pages/Evidence.js";
import { Job } from "./pages/Job.js";
import { Jobs } from "./pages/Jobs.js";
import { Landing } from "./pages/landing/Landing.js";
import { MetricsPage } from "./pages/Metrics.js";
import { NewJob } from "./pages/NewJob.js";
import { Settings } from "./pages/Settings.js";
import { SignIn } from "./pages/SignIn.js";

// Apply the saved or system theme before first paint.
try {
  const saved = localStorage.getItem("bursar.theme");
  document.documentElement.dataset.theme =
    saved === "light" || saved === "dark"
      ? saved
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
} catch {
  // Falls back to light until the app loads.
}

const queryClient = new QueryClient({
  defaultOptions: {
    // Live updates refetch on change; this is only a safety net if the stream is down.
    queries: { staleTime: 10_000, refetchInterval: 30_000, retry: 1 },
  },
});

function RequireSession({ children }: { children: ReactNode }) {
  const { session } = useSession();
  return session === null ? <Navigate to="/login" replace /> : children;
}

const root = document.getElementById("root");
if (root === null) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<SignIn />} />
              <Route path="/demo" element={<Demo />} />
              <Route path="/demo/decisions/:id" element={<DemoEvidence />} />
              <Route path="/docs" element={<Navigate to="/docs/introduction" replace />} />
              <Route path="/docs/:slug" element={<Docs />} />
              <Route
                path="/app"
                element={
                  <RequireSession>
                    <Shell />
                  </RequireSession>
                }
              >
                <Route path="jobs" element={<Jobs />} />
                <Route path="jobs/new" element={<NewJob />} />
                <Route path="jobs/:id" element={<Job />} />
                <Route path="approvals" element={<Approvals />} />
                <Route path="decisions/:id" element={<EvidencePage />} />
                <Route path="metrics" element={<MetricsPage />} />
                <Route path="settings" element={<Settings />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </SessionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
