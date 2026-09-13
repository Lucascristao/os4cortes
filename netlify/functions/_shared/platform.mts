import { getStore, getDeployStore } from "@netlify/blobs";

// Modern Functions receive the complete Blobs context, including uncachedEdgeURL.
// Do not call connectLambda: it replaces that context with legacy fields.
export function blobStore(name, context) {
  return context.deploy.context === "production"
    ? getStore({ name, consistency: "strong" })
    : getDeployStore({ name, consistency: "strong" });
}

export function safeHandler(handler) {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      console.error("OS4 request failed", { requestId: context.requestId, name: error?.name });
      return Response.json({ ok: false, error: "Falha temporária no servidor. Tente novamente.", requestId: context.requestId },
        { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  };
}
