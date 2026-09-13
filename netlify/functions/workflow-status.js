const crypto = require("crypto");

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
  const result = await store.get(key, { type: "json", consistency: "strong" });
  return result?.data ?? result ?? null;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const secret = process.env.OS4_SESSION_SECRET;
  if (!secret) return json(500, { ok: false, error: "Sessão não configurada." });

  const cookies = parseCookies(event.headers.cookie || "");
  const user = verifySession(cookies.os4_session, secret);
  if (!user?.email) return json(401, { ok: false, error: "Não autenticado." });

  const requestId = String(event.queryStringParameters?.id || "").trim();
  if (!requestId) return json(400, { ok: false, error: "ID do processamento ausente." });

  const { connectLambda, getStore } = await import("@netlify/blobs");
  connectLambda(event);
  const store = getStore("os4-jobs");
  const job = await getJSON(store, requestId);
  if (!job || job.ownerHash !== ownerHash(user.email)) {
    return json(404, { ok: false, error: "Processamento não encontrado." });
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
};
