import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Job } from "../lib/api.js";
import { Jobs } from "./Jobs.js";

const job = (over: Partial<Job>): Job =>
  ({
    id: "j",
    title: "A job",
    status: "ACTIVE",
    budget: "1.00",
    remaining: "0.90",
    settled: "0.05",
    reserved: "0.03",
    pendingApproval: "0",
    unresolved: "0.02",
    needsYou: 0,
    frozenReason: null,
    ...over,
  }) as Job;

function page(jobs: Job[]) {
  const client = new QueryClient();
  client.setQueryData(["jobs"], { jobs });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Jobs />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the jobs page totals", () => {
  it("adds up what's funded, paid and held across every job, and what waits for the owner", () => {
    const html = page([
      job({ id: "a", title: "First", needsYou: 2 }),
      job({ id: "b", title: "Second", settled: "0.10" }),
    ]);
    // React puts comment markers between adjacent text; compare what a reader would see.
    const text = html
      .replace(/<!-- -->/g, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ");
    expect(text).toContain("Funded 2.00 USDC"); // 1.00 + 1.00
    expect(text).toContain("Paid 0.15 USDC"); // 0.05 + 0.10
    expect(text).toContain("Held or stuck 0.10 USDC"); // (0.03 + 0.02) for each of two jobs
    expect(text).toContain("Waiting for you 2");
  });

  it("shows no totals before there is a job", () => {
    expect(page([])).not.toContain("Funded");
  });
});
