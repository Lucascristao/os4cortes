import crypto from "node:crypto";
import { blobStore, safeHandler } from "./_shared/platform.mts";

function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => {
      const i = part.indexOf("=");
      if (i < 0) return [part.trim(), ""];
      return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1))];
    }).filter(([key]) => key)
  );
}

function verifySession(token, secret) {
  try {
    const [encoded, sig] = String(token || "").split(".");
    if (!encoded || !sig) return null;
    const expected = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(fromBase64url(encoded));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function ownerHash(email) {
  return crypto.createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex");
}

async function getJSON(store, key) {
  return store.get(key, { type: "json" });
}

function json(statusCode, body) {
  return Response.json(body, { status: statusCode, headers: { "Cache-Control": "no-store" } });
}

export default safeHandler(async (request, context) => {
  if (request.method !== "GET") return json(405, { ok: false, error: "Método não permitido." });
  const secret = Netlify.env.get("OS4_SESSION_SECRET");
  if (!secret) return json(500, { ok: false, error: "Sessão não configurada." });

  const cookies = parseCookies(request.headers.get("cookie") || "");
  const user = verifySession(cookies.os4_session, secret);
  if (!user?.email) return json(401, { ok: false, error: "Não autenticado." });

  const requestId = String(new URL(request.url).searchParams.get("id") || "").trim();
  if (!requestId) return json(400, { ok: false, error: "ID do processamento ausente." });

  const store = blobStore("os4-jobs", context);
  const job = await getJSON(store, requestId);
  if (!job || job.ownerHash !== ownerHash(user.email)) {
    return json(404, { ok: false, error: "Processamento não encontrado." });
  }

  const now = Date.now();
  const createdTime = new Date(job.createdAt || 0).getTime();
  const updatedTime = new Date(job.updatedAt || job.createdAt || 0).getTime();
  const ageSinceCreated = now - createdTime;
  const ageSinceUpdated = now - updatedTime;

  // Auto-expira trabalhos que ficaram travados na fila sem início no GitHub Actions
  if (job.status === "queued" && ageSinceCreated > 3 * 60 * 1000) {
    job.status = "error";
    job.stage = "timeout";
    job.detail = "O tempo limite de espera na fila do GitHub Actions foi excedido. Tente novamente.";
    job.error = "Timeout na fila do GitHub Actions";
    job.updatedAt = new Date().toISOString();
    try { await store.setJSON(requestId, job); } catch {}
  } else if (job.status === "running" && ageSinceUpdated > 45 * 60 * 1000) {
    job.status = "error";
    job.stage = "timeout";
    job.detail = "Tempo limite de execução excedido.";
    job.error = "Timeout de processamento";
    job.updatedAt = new Date().toISOString();
    try { await store.setJSON(requestId, job); } catch {}
  }

  const safe = {
    id: requestId,
    kind: job.kind,
    status: job.status,
    stage: job.stage || "",
    detail: job.detail || "",
    percent: Number(job.percent || 0),
    stagePercent: job.stagePercent == null ? null : Number(job.stagePercent),
    current: job.current == null ? null : Number(job.current),
    total: job.total == null ? null : Number(job.total),
    cut: job.cut == null ? null : Number(job.cut),
    totalCuts: job.totalCuts == null ? null : Number(job.totalCuts),
    result: job.result || null,
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };

  return json(200, { ok: true, job: safe });
});

