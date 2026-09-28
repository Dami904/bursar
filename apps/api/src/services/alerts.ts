import { randomBytes } from "node:crypto";
import { alertTargets, alerts, telegramLinks, type Db } from "@bursar/db";
import { and, desc, eq } from "drizzle-orm";
import { badRequest, notFound } from "../http/errors.js";

/** An owner's alert targets. Webhook secrets are never shown again after creation. */
export async function listTargets(db: Db, ownerId: string) {
  const rows = await db
    .select()
    .from(alertTargets)
    .where(eq(alertTargets.ownerId, ownerId))
    .orderBy(desc(alertTargets.createdAt));
  return rows.map((t) => ({
    id: t.id,
    kind: t.kind,
    url: t.url,
    chatLinked: t.chatId !== null,
    createdAt: t.createdAt.toISOString(),
  }));
}

export async function addWebhook(db: Db, ownerId: string, url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("That isn't a URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw badRequest("Webhooks must be http(s)");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw badRequest("URLs with credentials in them are refused");
  }
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const [row] = await db
    .insert(alertTargets)
    .values({ ownerId, kind: "WEBHOOK", url: parsed.toString(), secret })
    .returning();
  if (row === undefined) throw new Error("insert returned nothing");
  return { id: row.id, url: row.url, secret };
}

export async function removeTarget(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .delete(alertTargets)
    .where(and(eq(alertTargets.id, id), eq(alertTargets.ownerId, ownerId)))
    .returning();
  if (row === undefined) throw notFound("Alert target");
}

/** A one-time link that connects a Telegram chat to this owner when opened. */
export async function telegramLink(db: Db, ownerId: string, botUsername: string) {
  const code = randomBytes(12).toString("base64url");
  await db.insert(telegramLinks).values({ code, ownerId });
  return { url: `https://t.me/${botUsername}?start=${code}` };
}

export async function sendTest(db: Db, ownerId: string, webUrl: string) {
  await db.insert(alerts).values({
    ownerId,
    type: "test",
    dedupeKey: `test:${ownerId}:${Date.now()}`,
    title: "Test alert from Bursar",
    body: "If you can read this, alerts reach you.",
    link: `${webUrl}/app/jobs`,
  });
}

export async function recentAlerts(db: Db, ownerId: string) {
  const rows = await db
    .select()
    .from(alerts)
    .where(eq(alerts.ownerId, ownerId))
    .orderBy(desc(alerts.createdAt))
    .limit(20);
  return rows.map((a) => ({
    id: a.id,
    type: a.type,
    title: a.title,
    body: a.body,
    link: a.link,
    at: a.createdAt.toISOString(),
    status: a.sentAt !== null ? "sent" : a.failedAt !== null ? "failed" : "sending",
    error: a.lastError,
  }));
}
