import crypto from "node:crypto";

export const terminalStatuses = ["completed", "error", "cancelled"];
export const controlKey = (id) => `workflow-stop:${id}`;
export const continueKey = (id, decisionId) => `workflow-continue:${id}:${decisionId}`;

export async function readControl(store, id, ...decisionIds) {
  const ids = [...new Set(decisionIds.filter(Boolean))];
  const results = await Promise.all([store.get(controlKey(id), { type: "json" }),
    ...ids.map(decisionId => store.get(continueKey(id, decisionId), { type: "json" }))]);
  return { action: results[0]?.action === "stop" ? "stop" : "wait",
    continuedDecisions: ids.filter((_, index) => results[index + 1]?.action === "continue") };
}

export function sessionOwner(request) {
  const secret = Netlify.env.get("OS4_SESSION_SECRET");
  if (!secret) return { error: "Sessão não configurada.", status: 500 };
  try {
    const cookie = (request.headers.get("cookie") || "").split(";")
      .map(part => part.trim()).find(part => part.startsWith("os4_session="));
    const [encoded, sig] = decodeURIComponent(cookie?.slice("os4_session=".length) || "").split(".");
    const expected = crypto.createHmac("sha256", secret).update(encoded || "").digest("hex");
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error();
    const user = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!user.email || !user.exp || Date.now() > user.exp) throw new Error();
    return { ownerHash: crypto.createHash("sha256").update(String(user.email).trim().toLowerCase()).digest("hex") };
  } catch {
    return { error: "Não autenticado.", status: 401 };
  }
}

export function pendingDecision(job, control) {
  const decision = job.pendingDecision;
  if (!decision?.id || control?.action === "stop" || control?.continuedDecisions?.includes(decision.id)) return null;
  return decision;
}

export function controlResponse(job, control, decisionId = null) {
  if (control?.action === "stop" || ["error", "cancelled"].includes(job.status)) {
    return { action: "stop", decisionId: decisionId || null };
  }
  if (decisionId && control?.continuedDecisions?.includes(decisionId)) return { action: "continue", decisionId };
  const pending = pendingDecision(job, control);
  return { action: "wait", decisionId: pending?.id || decisionId || null };
}

// Control has its own key: a delayed worker write cannot erase a user decision.
export function controlledJob(job, control) {
  if (terminalStatuses.includes(job.status)) return job;
  if (control?.action === "stop") return { ...job, status: "stopping", stage: "interrompendo",
    detail: "Parada solicitada. Aguardando o processador encerrar e preservar os arquivos já salvos.", pendingDecision: null };
  if (job.status === "paused" && !pendingDecision(job, control)) return { ...job, status: "running", stage: "retomando",
    detail: "Continuar confirmado. O corte com falha será pulado; o histórico foi preservado.", pendingDecision: null };
  return job;
}
