import crypto from "node:crypto";
import { blobStore, safeHandler } from "./_shared/platform.mts";
import { publicationCuts, publisherToken } from "./_shared/publisher.mts";
import { controlledJob, readControl } from "./_shared/workflow.mts";

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
  const stored = await store.get(link.requestId, { type: "json" });
  if (!stored || stored.folderId !== folderId || stored.ownerHash !== link.ownerHash) return respond(404, { ok: false });
  const job = controlledJob(stored, await readControl(store, link.requestId, stored.pendingDecision?.id));
  const cuts = await publicationCuts(store, link.requestId, job);
  const result = job.result;
  const isCount = value => Number.isSafeInteger(value) && value >= 0;
  // Explicit terminal counters distinguish failed generation from delayed
  // ready callbacks. Legacy jobs retain null rather than invented failures.
  const requestedCount = isCount(result?.requestedCount) ? result.requestedCount : job.totalCuts || null;
  const completedCount = isCount(job.completedCount) ? job.completedCount : isCount(result?.completedCount) ? result.completedCount : cuts.length;
  const failedCount = isCount(job.failedCount) ? job.failedCount : Array.isArray(result?.errors) ? result.errors.length : null;
  const pendingCount = Array.isArray(result?.pendingCuts) ? result.pendingCuts.length : 0;
  return respond(200, { ok: true, requestId: link.requestId, folderId, status: job.status, totalCuts: job.totalCuts || 0,
    readyCount: cuts.length, requestedCount, completedCount, failedCount, pendingCount, cuts, detail: job.detail || "", updatedAt: job.updatedAt,
    stale: Date.now() - Date.parse(job.updatedAt || job.createdAt) > 15 * 60 * 1000,
    error: ["error", "cancelled"].includes(job.status) ? String(job.error || job.detail || "Processamento interrompido").slice(0, 500) : null });
});
