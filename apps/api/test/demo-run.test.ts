import { DEMO_SCENES, jobs } from "@bursar/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { db, seedJob } from "./support.js";

const MIN = 60_000;
const PLAN = {
  cooldownMs: 5 * MIN,
  maxPerDay: 10,
  lastsUntil: new Date(Date.now() + 24 * 86_400_000),
  reserveMicros: 100_000n,
};

async function get(app: ReturnType<typeof createApp>, path: string) {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
async function post(app: ReturnType<typeof createApp>, path: string) {
  const response = await app.request(path, { method: "POST" });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A demo job that has finished its last scene a while ago, and an app that offers the button. */
async function demo(options: { budget?: string; idleMinutes?: number } = {}) {
  const { job } = await seedJob({ budget: options.budget ?? "2.00" });
  await db
    .update(jobs)
    .set({ operatorRunAt: new Date(Date.now() - (options.idleMinutes ?? 30) * MIN) })
    .where(eq(jobs.id, job.id));
  const app = createApp(db, { demoJobId: job.id, demoRun: PLAN, rateLimits: false });
  return { app, job };
}

describe("running the public demo with a click", () => {
  it("is off when the demo isn't set up to be run from the page", async () => {
    const { job } = await seedJob();
    const app = createApp(db, { demoJobId: job.id, rateLimits: false });
    expect((await get(app, "/demo/run")).body).toEqual({ enabled: false });
    expect((await post(app, "/demo/run")).status).toBe(404);
  });

  it("shows the next scene, what it may spend, and that it can run", async () => {
    const { app } = await demo();
    const { status, body } = await get(app, "/demo/run");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      enabled: true,
      canRun: true,
      reason: null,
      next: { number: 1, of: DEMO_SCENES.length, title: DEMO_SCENES[0]!.title, maxCost: "0.02" },
      runsToday: 0,
      maxPerDay: 10,
    });
  });

  it("accepts one click, and holds a second until the worker has picked it up", async () => {
    const { app } = await demo();
    const first = await post(app, "/demo/run");
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ enabled: true, accepted: true, canRun: false });
    const second = await post(app, "/demo/run");
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).toContain("DEMO_PENDING");
  });

  it("says to wait when the last scene has only just finished", async () => {
    const { app } = await demo({ idleMinutes: 1 });
    const refused = await post(app, "/demo/run");
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("DEMO_COOLDOWN");
    const status = await get(app, "/demo/run");
    expect(status.body).toMatchObject({ canRun: false, reason: "COOLDOWN" });
    expect(status.body.retryAfterSeconds).toBeGreaterThan(200);
  });

  it("refuses when the budget couldn't be spread to last, and the demo stays unqueued", async () => {
    const { app, job } = await demo({ budget: "0.10" });
    // 0.10 USDC over 24 days leaves well under the cheapest scene's 0.02 a day.
    const refused = await post(app, "/demo/run");
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("DEMO_BUDGET_PACE");
    expect(JSON.stringify(refused.body)).toContain("3 November");
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.operatorRunAt).not.toBeNull();
  });
});
