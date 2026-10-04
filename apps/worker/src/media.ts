import { authorizations, type Db } from "@bursar/db";
import { assertFetchable, publicFetchOptions, UnsafeUrlError } from "@bursar/payments";
import { put } from "@vercel/blob";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { errorText, log } from "./log.js";

/** An image, audio or video from a delivered result, kept in our own storage. */
export interface MediaFile {
  readonly url: string;
  readonly kind: "image" | "audio" | "video";
  readonly contentType: string;
  readonly bytes: number;
}

/** Saves a file and returns the address it can be shown from. */
export type MediaStore = (path: string, bytes: Uint8Array, contentType: string) => Promise<string>;

export interface MediaDeps {
  readonly db: Db;
  /** Where files are kept. Without one (no storage configured) nothing is looked at. */
  readonly store: MediaStore | null;
  /** Local development only: fetch files from 127.0.0.1. */
  readonly allowPrivateHosts?: boolean;
  /** Largest file kept. Default 25 MB. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
/** Links worth a look in one result: a seller's answer isn't a place to find hundreds. */
const MAX_CANDIDATES = 6;
/** How many times a result is tried when a link fails in a way that might pass. */
const MAX_TRIES = 3;
/** Only recent results are looked at, so a first run after an upgrade doesn't sweep history. */
const LOOK_BACK_MS = 24 * 3600_000;
const RETRY_EVERY_MS = 60_000;
const BATCH = 5;
const MAX_REDIRECTS = 3;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/** Image bytes sellers sometimes return inline (base64), recognised by their first bytes. */
function sniffImage(bytes: Uint8Array): string | null {
  const at = (...head: number[]) => head.every((b, i) => bytes[i] === b);
  if (at(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return null;
}

type Candidate = { readonly url: string } | { readonly base64: string };

/** Links and inline images in a delivered result (JSON, or a bare link), in order, deduplicated. */
export function candidatesOf(deliverable: string): Candidate[] {
  const found: Candidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: Candidate, key: string) => {
    if (seen.has(key) || found.length >= MAX_CANDIDATES) return;
    seen.add(key);
    found.push(candidate);
  };
  const visit = (value: unknown, key: string, depth: number) => {
    if (depth > 6) return;
    if (typeof value === "string") {
      if (/^https?:\/\/\S+$/.test(value)) add({ url: value }, value);
      else if (/^b64/i.test(key) && /^[A-Za-z0-9+/=\s]{64,}$/.test(value)) {
        add({ base64: value }, value.slice(0, 64));
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
    } else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) visit(v, k, depth + 1);
    }
  };
  try {
    visit(JSON.parse(deliverable), "", 0);
  } catch {
    const text = deliverable.trim();
    if (/^https?:\/\/\S+$/.test(text)) add({ url: text }, text);
  }
  return found;
}

const kindOf = (contentType: string): MediaFile["kind"] | null => {
  if (contentType === "image/svg+xml") return null; // can carry script when opened on its own
  const family = contentType.split("/")[0];
  return family === "image" || family === "audio" || family === "video" ? family : null;
};

/** Not worth keeping (not media, too large, a missing page): no point trying again. */
class Skipped extends Error {}

/** Reads a response body, refusing more than `max` bytes. */
async function readLimited(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > max) throw new Skipped("too large");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Skipped("too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Fetches one candidate. Throws Skipped when it isn't media, an Error when it might work later. */
async function fetchMedia(
  candidate: Candidate,
  deps: MediaDeps,
): Promise<{ bytes: Uint8Array; contentType: string; kind: MediaFile["kind"] }> {
  const max = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  if ("base64" in candidate) {
    const bytes = Buffer.from(candidate.base64.replace(/\s/g, ""), "base64");
    if (bytes.byteLength > max) throw new Skipped("too large");
    const contentType = sniffImage(bytes);
    if (contentType === null) throw new Skipped("not an image");
    return { bytes, contentType, kind: "image" };
  }
  // Every hop is checked before it's requested (a link or a redirect to a literal private address
  // would skip the connection-level guard), so redirects are followed here, a few at most.
  let response: Response | undefined;
  let target = candidate.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let safe: URL;
    try {
      safe = await assertFetchable(target, deps.allowPrivateHosts === true);
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw new Skipped(error.message);
      throw error;
    }
    response = await fetch(safe, {
      ...publicFetchOptions(deps.allowPrivateHosts === true),
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const next = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || next === null) break;
    await response.body?.cancel();
    target = new URL(next, safe).href;
    response = undefined;
  }
  if (response === undefined) throw new Skipped("too many redirects");
  if (response.status >= 400 && response.status < 500) throw new Skipped(`HTTP ${response.status}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";", 1)
    .join("")
    .trim()
    .toLowerCase();
  const kind = kindOf(contentType);
  if (kind === null) {
    await response.body?.cancel();
    throw new Skipped(`not media (${contentType || "no type"})`);
  }
  return { bytes: await readLimited(response, max), contentType, kind };
}

/** Results that failed in a way that might pass: when they were last tried, and how often. */
const tries = new Map<string, { at: number; count: number }>();

/**
 * Keeps the images, audio and video that settled purchases delivered. A result links to a file on
 * the seller's own storage, which may vanish; we download it once and save it where the console can
 * show it. Safe to repeat: a result is marked once it's been looked at.
 */
export async function keepMediaOnce(deps: MediaDeps): Promise<number> {
  const { db, store } = deps;
  if (store === null) return 0;
  const rows = await db
    .select()
    .from(authorizations)
    .where(
      and(
        eq(authorizations.state, "SETTLED"),
        isNull(authorizations.media),
        isNotNull(authorizations.deliverable),
        gt(authorizations.updatedAt, new Date(Date.now() - LOOK_BACK_MS)),
      ),
    )
    // More than one batch, so results waiting to be retried don't hold up new ones.
    .limit(BATCH * 4);
  let kept = 0;
  let looked = 0;
  for (const auth of rows) {
    if (looked >= BATCH) break;
    const tried = tries.get(auth.id);
    if (tried !== undefined && Date.now() - tried.at < RETRY_EVERY_MS) continue;
    looked += 1;
    const files: MediaFile[] = [];
    let retryable = false;
    for (const [index, candidate] of candidatesOf(auth.deliverable ?? "").entries()) {
      try {
        const { bytes, contentType, kind } = await fetchMedia(candidate, deps);
        const extension = EXTENSIONS[contentType] ?? contentType.split("/")[1] ?? "bin";
        const url = await store(`media/${auth.id}/${index}.${extension}`, bytes, contentType);
        files.push({ url, kind, contentType, bytes: bytes.byteLength });
      } catch (error) {
        if (error instanceof Skipped) continue;
        retryable = true;
        log.warn("couldn't keep a delivered file", {
          authorizationId: auth.id,
          error: errorText(error),
        });
      }
    }
    const count = (tried?.count ?? 0) + 1;
    if (files.length === 0 && retryable && count < MAX_TRIES) {
      tries.set(auth.id, { at: Date.now(), count });
      continue;
    }
    await db.update(authorizations).set({ media: files }).where(eq(authorizations.id, auth.id));
    tries.delete(auth.id);
    kept += files.length;
    if (files.length > 0) {
      log.info("kept delivered media", { authorizationId: auth.id, files: files.length });
    }
  }
  return kept;
}

/** Vercel Blob as the store. Files are public, under an unguessable address. */
export function blobStore(token: string): MediaStore {
  return async (path, bytes, contentType) => {
    const saved = await put(path, Buffer.from(bytes), {
      access: "public",
      contentType,
      token,
      addRandomSuffix: true,
    });
    return saved.url;
  };
}
