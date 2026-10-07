import crypto from "node:crypto";
import { blobStore, safeHandler } from "./_shared/platform.mts";
import { readyCut, readyKey } from "./_shared/publisher.mts";

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

  // Delayed progress must not overwrite a completed result or a terminal error.
  if (["completed", "error", "cancelled"].includes(current.status)) return json(200, { ok: true });

  if (body.ready_cut) {
    const cut = readyCut(body.ready_cut);
    if (!cut || current.kind !== "render" || cut.index > current.totalCuts) {
      return json(400, { ok: false, error: "Pacote de corte incompleto." });
    }
    await store.setJSON(readyKey(requestId, cut.index), cut);
  }

  const allowedStatus = new Set(["queued", "running", "completed", "error", "cancelled"]);
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
  if (body.error != null) next.error = String(body.error).slice(0, 2000);

  await store.setJSON(requestId, next);
  return json(200, { ok: true });
});
