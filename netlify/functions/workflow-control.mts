import { blobStore, safeHandler } from "./_shared/platform.mts";
import { continueKey, controlKey, controlResponse, controlledJob, pendingDecision, readControl, sessionOwner, terminalStatuses } from "./_shared/workflow.mts";

const json = (status, body) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export default safeHandler(async (request, context) => {
  if (request.method !== "POST") return json(405, { ok: false, error: "Método não permitido." });
  const owner = sessionOwner(request);
  if (owner.error) return json(owner.status, { ok: false, error: owner.error });
  // Browser calls use a same-origin JSON request. Reject cross-site control.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json(403, { ok: false, error: "Origem inválida." });
  let body;
  try { body = await request.json(); } catch { return json(400, { ok: false, error: "JSON inválido." }); }
  const id = String(body?.requestId || body?.id || "").trim();
  const action = body?.action;
  if (!id || !["continue", "stop"].includes(action)) return json(400, { ok: false, error: "Informe o processamento e uma ação válida." });
  const store = blobStore("os4-jobs", context);
  const job = await store.get(id, { type: "json" });
  if (!job || job.ownerHash !== owner.ownerHash) return json(404, { ok: false, error: "Processamento não encontrado." });
  const decisionId = typeof body.decisionId === "string" ? body.decisionId : null;
  const previous = await readControl(store, id, job.pendingDecision?.id, decisionId);
  if (terminalStatuses.includes(job.status)) return json(409, { ok: false, error: "Este processamento já terminou." });
  if (job.kind !== "render") return json(400, { ok: false, error: "O controle de parada está disponível para geração de cortes." });
  if (action === "continue") {
    if (previous.action === "stop") return json(409, { ok: false, error: "A parada deste processamento já foi solicitada." });
    if (decisionId && previous.continuedDecisions?.includes(decisionId)) return json(200, { ok: true, control: { action, decisionId } });
    const pending = pendingDecision(job, previous);
    if (!decisionId || pending?.id !== decisionId || job.status !== "paused") {
      return json(409, { ok: false, error: "Esta decisão não está mais pendente. Atualize o andamento." });
    }
  }
  // Each decision has its own immutable acknowledgement. Stop has a separate,
  // sticky key, so two browsers cannot race a continue write over a stop.
  await store.setJSON(action === "stop" ? controlKey(id) : continueKey(id, decisionId), { action, updatedAt: new Date().toISOString() });
  const control = await readControl(store, id, job.pendingDecision?.id, decisionId);
  // Status/progress both reconcile the durable control record before responding.
  return json(200, { ok: true, control: control.action === "stop" ? controlResponse(controlledJob(job, control), control) : { action, decisionId } });
});
