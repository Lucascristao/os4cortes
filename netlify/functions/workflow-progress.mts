import crypto from "node:crypto";
import { blobStore, safeHandler } from "./_shared/platform.mts";
import { readyCut, readyKey } from "./_shared/publisher.mts";
import { controlResponse, controlledJob, pendingDecision, readControl, terminalStatuses } from "./_shared/workflow.mts";

function sha(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

async function getJSON(store, key) {
  return store.get(key, { type: "json" });
}

function json(statusCode, body) {
  return Response.json(body, { status: statusCode, headers: { "Cache-Control": "no-store" } });
}

export default safeHandler(async (request, context) => {
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Método não permitido." });
  }

  let body;
  try {
    body = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
  } catch {
    return json(400, { ok: false, error: "JSON inválido." });
  }

  const requestId = String(body.request_id || "").trim();
  const token = String(body.token || "").trim();
  if (!requestId || !token) {
    return json(400, { ok: false, error: "request_id/token ausente." });
  }

  const store = blobStore("os4-jobs", context);
  const current = await getJSON(store, requestId);
  if (!current) return json(404, { ok: false, error: "Job não encontrado." });

  const expected = Buffer.from(String(current.callbackHash || ""));
  const received = Buffer.from(sha(token));
  if (!expected.length || expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return json(403, { ok: false, error: "Token de callback inválido." });
  }

  const control = await readControl(store, requestId, current.pendingDecision?.id, body.decision_id);
  const reply = (job) => json(200, { ok: true, control: controlResponse(job, control, body.decision_id) });
  // Replayed heartbeats cannot resume a pause, repeat a resolved decision, or
  // overwrite terminal results. User control is kept outside the worker key.
  if (terminalStatuses.includes(current.status)) return reply(current);
  if (body.decision_id && control?.continuedDecisions?.includes(body.decision_id)) return reply(current);
  if (pendingDecision(current, control) && !["paused", "error", "cancelled"].includes(body.status)) return reply(current);
  if (pendingDecision(current, control) && body.status === "paused" && body.decision_id !== current.pendingDecision.id) return reply(current);

  if (body.status === "paused" && (typeof body.decision_id !== "string" || !/^[\w-]{1,100}$/.test(body.decision_id) || !body.cut_error)) {
    return json(400, { ok: false, error: "Pausa sem identificação da decisão ou motivo do corte." });
  }

  if (body.ready_cut) {
    const cut = readyCut(body.ready_cut);
    if (!cut || current.kind !== "render" || cut.index > current.totalCuts) {
      return json(400, { ok: false, error: "Pacote de corte incompleto." });
    }
    await store.setJSON(readyKey(requestId, cut.index), cut);
  }

  const allowedStatus = new Set(["queued", "running", "paused", "completed", "error", "cancelled"]);
  const next = {
    ...current,
    updatedAt: new Date().toISOString(),
  };

  if (allowedStatus.has(body.status)) next.status = body.status;
  if (body.stage != null) next.stage = String(body.stage).slice(0, 80);
  if (body.detail != null) next.detail = String(body.detail).slice(0, 500);
  if (body.percent != null && Number.isFinite(Number(body.percent))) {
    next.percent = Math.max(0, Math.min(100, Number(body.percent)));
  }
  if (body.stage_percent != null && Number.isFinite(Number(body.stage_percent))) {
    next.stagePercent = Math.max(0, Math.min(100, Number(body.stage_percent)));
  }
  if (body.current != null && Number.isFinite(Number(body.current))) next.current = Number(body.current);
  if (body.total != null && Number.isFinite(Number(body.total))) next.total = Number(body.total);
  if (body.cut != null && Number.isFinite(Number(body.cut))) next.cut = Number(body.cut);
  if (body.total_cuts != null && Number.isFinite(Number(body.total_cuts))) next.totalCuts = Number(body.total_cuts);
  if (body.result && typeof body.result === "object") next.result = body.result;
  if (body.error != null && String(body.error)) next.error = String(body.error).slice(0, 2000);

  const isCount = value => Number.isSafeInteger(value) && value >= 0;
  const errors = new Map();
  for (const error of [...(current.failureHistory || current.result?.errors || []), ...(body.result?.errors || []), ...(body.cut_error ? [body.cut_error] : [])]) {
    if (isCount(error?.index) && error.index > 0 && error.index <= (next.totalCuts || Infinity)) {
      errors.set(error.index, { ...error, index: error.index, titulo: String(error.titulo || `Corte ${error.index}`).slice(0, 500), error: String(error.error || "Falha no processamento.").slice(0, 2000) });
    }
  }
  const cuts = new Map();
  for (const cut of [...(current.result?.cuts || []), ...(body.result?.cuts || [])]) {
    if (cut?.index) cuts.set(cut.index, cut);
  }
  const published = body.ready_cut ? readyCut(body.ready_cut) : null;
  if (published && !cuts.has(published.index)) cuts.set(published.index, published);
  const pendingCuts = new Map();
  for (const cut of [...(current.result?.pendingCuts || []), ...(body.result?.pendingCuts || [])]) {
    if (Number.isSafeInteger(cut?.index) && cut.index > 0 && !cuts.has(cut.index)) pendingCuts.set(cut.index, cut);
  }
  if (current.kind === "render") {
    next.failureHistory = [...errors.values()].sort((a, b) => a.index - b.index);
    next.completedCount = Math.max(current.completedCount || 0, cuts.size, isCount(body.completed_count) ? body.completed_count : 0, isCount(body.result?.completedCount) ? body.result.completedCount : 0);
    next.failedCount = Math.max(current.failedCount || 0, errors.size, isCount(body.failed_count) ? body.failed_count : 0);
    next.pendingCount = pendingCuts.size;
    const lastSuccess = Math.max(0, ...cuts.keys());
    const lastFailure = Math.max(0, ...errors.keys());
    const outcomeIndex = Math.max(lastSuccess, lastFailure);
    const previousSuccesses = new Set((current.result?.cuts || []).map(cut => cut.index));
    const savedNewCut = [...cuts.keys()].some(index => !previousSuccesses.has(index));
    next.consecutiveFailures = current.consecutiveFailures || 0;
    if (savedNewCut && lastSuccess >= lastFailure) next.consecutiveFailures = 0;
    else if (outcomeIndex > (current.lastOutcomeIndex || 0)) {
      next.consecutiveFailures = lastSuccess > lastFailure ? 0
        : isCount(body.consecutive_failures) ? body.consecutive_failures
          : next.consecutiveFailures + 1;
    }
    next.lastOutcomeIndex = Math.max(current.lastOutcomeIndex || 0, outcomeIndex);
    if (current.result || body.result || cuts.size || errors.size || pendingCuts.size) {
      const fallback = { requestId, folderId: current.folderId,
        driveFolderUrl: `https://drive.google.com/drive/folders/${current.folderId}`, requestedCount: current.totalCuts,
        completedCount: next.completedCount };
      next.result = { ...(current.result || body.result || fallback), ...(body.result || {}),
        cuts: [...cuts.values()].sort((a, b) => a.index - b.index), errors: next.failureHistory };
      if (Object.hasOwn(current.result || {}, "pendingCuts") || Object.hasOwn(body.result || {}, "pendingCuts") || pendingCuts.size) {
        next.result.pendingCuts = [...pendingCuts.values()].sort((a, b) => a.index - b.index);
      }
      // Maintain original result shapes for legacy callbacks while keeping
      // explicit renderer counters accurate and immune to stale heartbeats.
      if (Object.hasOwn(next.result, "completedCount")) next.result.completedCount = next.completedCount;
      if (Object.hasOwn(next.result, "failedCount")) next.result.failedCount = next.failedCount;
      if (Object.hasOwn(next.result, "consecutiveFailures")) next.result.consecutiveFailures = next.consecutiveFailures;
    }
  }
  if (body.status === "paused") next.pendingDecision = { id: body.decision_id, cutError: next.failureHistory?.find(error => error.index === body.cut_error.index) || body.cut_error };
  else if (terminalStatuses.includes(next.status) || !pendingDecision(current, control)) next.pendingDecision = null;

  const controlled = controlledJob(next, control);
  await store.setJSON(requestId, controlled);
  return reply(controlled);
});
