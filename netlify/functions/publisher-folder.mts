import crypto from "node:crypto";
import { blobStore, safeHandler } from "./_shared/platform.mts";
import { publicationCuts, publisherToken } from "./_shared/publisher.mts";

export default safeHandler(async (request, context) => {
  const respond = (code, data) => Response.json(data, { status: code, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "GET") return respond(405, { ok: false });
  const folderId = new URL(request.url).searchParams.get("folderId") || "";
  if (!/^[\w-]{20,200}$/.test(folderId)) return respond(400, { ok: false, error: "Pasta inválida." });
  const secret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  if (!secret) return respond(503, { ok: false, error: "Acompanhamento indisponível." });
  const received = Buffer.from((request.headers.get("authorization") || "").replace(/^Bearer /, ""));
  const expected = Buffer.from(publisherToken(secret, folderId));
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return respond(401, { ok: false, error: "Reconecte o acompanhamento desta pasta." });
  }
  const store = blobStore("os4-jobs", context);
  const link = await store.get(`publisher-folder:${folderId}`, { type: "json" });
  if (!link) return respond(404, { ok: false, error: "Aguardando início da geração dos cortes." });
  const job = await store.get(link.requestId, { type: "json" });
  if (!job || job.folderId !== folderId || job.ownerHash !== link.ownerHash) return respond(404, { ok: false });
  const cuts = await publicationCuts(store, link.requestId, job);
  const result = ["completed", "error", "cancelled"].includes(job.status) ? job.result : null;
  const isCount = value => Number.isSafeInteger(value) && value >= 0;
  // Explicit terminal counters distinguish failed generation from delayed
  // ready callbacks. Legacy jobs retain null rather than invented failures.
  const requestedCount = isCount(result?.requestedCount) ? result.requestedCount : null;
  const completedCount = isCount(result?.completedCount) ? result.completedCount : null;
  const failedCount = Array.isArray(result?.errors) ? result.errors.length : null;
  return respond(200, { ok: true, requestId: link.requestId, folderId, status: job.status, totalCuts: job.totalCuts || 0,
    readyCount: cuts.length, requestedCount, completedCount, failedCount, cuts, detail: job.detail || "", updatedAt: job.updatedAt,
    stale: Date.now() - Date.parse(job.updatedAt || job.createdAt) > 15 * 60 * 1000,
    error: ["error", "cancelled"].includes(job.status) ? String(job.error || job.detail || "Processamento interrompido").slice(0, 500) : null });
});
