import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api.js";
import { DemoUnavailable } from "./Demo.js";

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
