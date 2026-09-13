exports.handler = async (event) => {
  try {
    const { connectLambda, getStore } = await import("@netlify/blobs");
    connectLambda(event);
    const store = getStore("os4-probe", { consistency: "strong" });
    const key = "health";
    const value = { ok: true, at: new Date().toISOString() };
    await store.setJSON(key, value);
    const read = await store.get(key, { type: "json" });
    await store.delete(key);
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, readOk: Boolean(read?.ok), hasBlobsContext: Boolean(event.blobs) }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 500), hasBlobsContext: Boolean(event.blobs) }),
    };
  }
};
