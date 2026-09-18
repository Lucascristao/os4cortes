import { safeHandler } from "./_shared/platform.mts";

function validYoutubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const id = host === "youtu.be" ? url.pathname.slice(1)
      : url.pathname === "/watch" ? url.searchParams.get("v")
      : url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)\/?$/)?.[1];
    return url.protocol === "https:" && !url.username && !url.password &&
      ["youtube.com", "m.youtube.com", "youtu.be"].includes(host) && /^[\w-]{11}$/.test(id || "");
  } catch {
    return false;
  }
}

export default safeHandler(async (request: Request) => {
  const reqUrl = new URL(request.url);
  const targetUrl = reqUrl.searchParams.get("url") || "";

  if (!targetUrl || !validYoutubeUrl(targetUrl)) {
    return Response.json(
      { ok: false, error: "URL inválida do YouTube." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const resp = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`);
    if (!resp.ok) {
      return Response.json(
        { ok: false, error: "Não foi possível carregar os dados do YouTube." },
        { status: resp.status, headers: { "Cache-Control": "no-store" } }
      );
    }
    const data = (await resp.json()) as any;
    return Response.json(
      {
        ok: true,
        title: String(data.title || "").trim(),
        author: String(data.author_name || "").trim(),
      },
      { status: 200, headers: { "Cache-Control": "public, max-age=3600" } }
    );
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err.message || "Erro de conexão ao buscar dados do vídeo." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
});
