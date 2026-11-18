import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LiveRun } from "../lib/api.js";
import { LiveRunView, sinceStart } from "./LiveRun.js";

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

const run = (active: boolean, lines: [string, string][]): LiveRun => ({
  active,
  runKey: "r",
  events: lines.map(([kind, text], i) => ({
    id: i + 1,
    at: at(i * 7),
    depth: 0,
    kind: kind as LiveRun["events"][number]["kind"],
    text,
  })),
});

describe("the live run panel", () => {
  it("shows nothing before any run has reported", () => {
    expect(renderToStaticMarkup(<LiveRunView live={run(false, [])} />)).toBe("");
  });

  it("says it's working now, and shows each line with how long after the start it happened", () => {
    const html = renderToStaticMarkup(
      <LiveRunView
        live={run(true, [
          ["started", "Starting a run"],
          ["step", 'Searching the marketplace for "news"'],
          ["found", "Found 3 services"],
          ["paid", "Paid 0.02 USDC"],
        ])}
      />,
    );
    expect(html).toContain("Working now");
    expect(html).toContain("Found 3 services");
    expect(html).toContain("Paid 0.02 USDC");
    expect(html).toContain("+0s");
    expect(html).toContain("+21s");
    expect(html).toContain('aria-live="polite"');
  });

  it("shows text as text: a line that looks like markup is not markup", () => {
    const html = renderToStaticMarkup(
      <LiveRunView live={run(true, [["step", '<img src=x onerror="alert(1)">']])} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("after the run, shows the last few lines and offers the rest", () => {
    const lines: [string, string][] = Array.from({ length: 9 }, (_, i) => [
      "step",
      `Step ${i + 1}`,
    ]);
    const html = renderToStaticMarkup(<LiveRunView live={run(false, lines)} />);
    expect(html).toContain("Last run");
    expect(html).toContain("Show 3 earlier steps");
    expect(html).not.toContain("Step 1<");
    expect(html).toContain("Step 9");
  });

  it("formats elapsed time", () => {
    expect(sinceStart(0, 12_000)).toBe("+12s");
    expect(sinceStart(0, 65_000)).toBe("+1m 05s");
    expect(sinceStart(5_000, 1_000)).toBe("+0s");
  });
});
