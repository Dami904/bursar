import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api.js";
import { DemoUnavailable, RunPanel, type RunStatus } from "./Demo.js";

const page = (error: unknown) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <DemoUnavailable error={error} onRetry={() => undefined} />
    </MemoryRouter>,
  );

describe("when there is no demo to show", () => {
  it("says the demo is being set up when the server has none, without an error code", () => {
    const html = page(new ApiError(404, "NOT_FOUND", "Demo not found"));
    expect(html).toContain("The live demo is being set up");
    expect(html).not.toContain("NOT_FOUND");
    expect(html).not.toContain("Demo not found");
    expect(html).toContain('href="/docs/introduction"');
    expect(html).not.toContain("Try again");
  });

  it("offers a retry when the server can't be reached", () => {
    const html = page(new Error("Failed to fetch"));
    expect(html).toContain("The demo isn&#x27;t answering right now");
    expect(html).toContain("Try again");
  });
});

const panel = (status: RunStatus) => {
  const client = new QueryClient();
  client.setQueryData(["demo-run"], status);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RunPanel />
    </QueryClientProvider>,
  );
};

const next = { number: 2, of: 6, title: "Buy a stock image", maxCost: "0.05" };

describe("the button that runs a demo scene", () => {
  it("offers the next scene, what it may spend, and an enabled button", () => {
    const html = panel({ enabled: true, canRun: true, next, runsToday: 1, maxPerDay: 10 });
    expect(html).toContain("Scene 2 of 6: Buy a stock image");
    expect(html).toContain("up to 0.05 testnet");
    expect(html).toContain("Run this scene");
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("1 of 10");
  });

  it("says why not, and disables the button, when the server says not now", () => {
    const html = panel({
      enabled: true,
      canRun: false,
      message: "The last scene is still finishing. Give it a few minutes.",
      next,
      runsToday: 3,
      maxPerDay: 10,
    });
    expect(html).toContain("The last scene is still finishing");
    expect(html).toContain('disabled=""');
  });

  it("shows nothing when the demo can't be run from the page", () => {
    expect(panel({ enabled: false })).toBe("");
  });
});
