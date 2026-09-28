import { alerts } from "@bursar/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { db, seedJob } from "./support.js";

const withTelegram = createApp(db, {
  webOrigins: ["http://localhost:5173"],
  telegramBot: "bursar_test_bot",
});
const without = createApp(db);

async function call(
  app: typeof without,
  method: string,
  path: string,
  key: string,
  payload?: unknown,
) {
  const response = await app.request(path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("alert settings", () => {
  it("adds a webhook, shows its secret once, and lists it without the secret", async () => {
    const { ownerKey } = await seedJob();
    const added = await call(without, "POST", "/alerts/webhooks", ownerKey, {
      url: "https://hooks.example.com/bursar",
    });
    expect(added.status).toBe(201);
    expect(added.body.secret).toMatch(/^whsec_/);
    const listed = await call(without, "GET", "/alerts", ownerKey);
    expect(listed.body.targets).toEqual([
      expect.objectContaining({ kind: "WEBHOOK", url: "https://hooks.example.com/bursar" }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(added.body.secret as string);
  });

  it("refuses non-http URLs and URLs with credentials", async () => {
    const { ownerKey } = await seedJob();
    expect(
      (await call(without, "POST", "/alerts/webhooks", ownerKey, { url: "file:///etc/passwd" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(without, "POST", "/alerts/webhooks", ownerKey, {
          url: "https://user:pass@hooks.example.com",
        })
      ).status,
    ).toBe(400);
  });

  it("only the owner can remove their target", async () => {
    const a = await seedJob();
    const b = await seedJob();
    const added = await call(without, "POST", "/alerts/webhooks", a.ownerKey, {
      url: "https://a.example.com",
    });
    const id = added.body.id as string;
    expect((await call(without, "POST", `/alerts/targets/${id}/remove`, b.ownerKey)).status).toBe(
      404,
    );
    expect((await call(without, "POST", `/alerts/targets/${id}/remove`, a.ownerKey)).status).toBe(
      200,
    );
  });

  it("queues a test alert", async () => {
    const { ownerKey } = await seedJob();
    await call(without, "POST", "/alerts/test", ownerKey);
    expect(await db.select().from(alerts)).toMatchObject([{ type: "test" }]);
  });

  it("gives a one-time Telegram link when a bot is configured", async () => {
    const { ownerKey } = await seedJob();
    expect((await call(without, "POST", "/alerts/telegram", ownerKey)).status).toBe(400);
    const link = await call(withTelegram, "POST", "/alerts/telegram", ownerKey);
    expect(link.body.url).toMatch(/^https:\/\/t\.me\/bursar_test_bot\?start=[A-Za-z0-9_-]{16}$/);
  });

  it("agents can't touch alert settings", async () => {
    const { agents } = await seedJob();
    expect((await call(without, "GET", "/alerts", agents[0]!.key)).status).toBe(403);
  });
});
