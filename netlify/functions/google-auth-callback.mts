import crypto from "node:crypto";

function env(name: string): string {
  return ((globalThis as any).Netlify?.env?.get(name) || "").trim();
}

function fromBase64url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function validateState(state: string, secret: string): boolean {
  try {
    const raw = fromBase64url(state);
    const [ts, sig] = raw.split(".");
    if (!ts || !sig) return false;

    const age = Date.now() - Number(ts);
    if (!Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000) {
      return false;
    }

    const expected = crypto.createHmac("sha256", secret).update(ts).digest("hex");
    const left = Buffer.from(sig, "utf8");
    const right = Buffer.from(expected, "utf8");

    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function driveFetch(
  accessToken: string,
  url: string,
  options: RequestInit = {}
): Promise<any> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Drive API ${response.status}: ${text}`);
  }

  return response.json();
}

async function ensureFolder(accessToken: string): Promise<string> {
  const query = encodeURIComponent(
    "name = 'OS4 Cortes' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
  );

  const found = await driveFetch(
    accessToken,
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&pageSize=10`
  );

  if (found.files && found.files.length > 0) {
    return found.files[0].id;
  }

  const created = await driveFetch(
    accessToken,
    "https://www.googleapis.com/drive/v3/files?fields=id,name",
    {
      method: "POST",
      body: JSON.stringify({
        name: "OS4 Cortes",
        mimeType: "application/vnd.google-apps.folder",
      }),
    }
  );

  return created.id;
}

export default async (req: Request) => {
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    return new Response("Credenciais OAuth do Google não configuradas no Netlify.", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error") || "";

  if (error) {
    return new Response(`Google retornou erro: ${error}`, {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (!code || !state || !validateState(state, clientSecret)) {
    return new Response(
      "Retorno OAuth inválido ou expirado. Inicie a conexão novamente.",
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }

  const redirectUri = `${url.origin}/api/google-drive/callback`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenData: any = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    return new Response(JSON.stringify(tokenData, null, 2), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  if (!tokenData.refresh_token) {
    return new Response(
      "O Google não devolveu refresh_token. Revogue o acesso do app na conta Google e tente novamente.",
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }

  const folderId = await ensureFolder(tokenData.access_token);

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Google Drive conectado — OS4 Cortes</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b0b;color:#f5f5f5;margin:0;padding:24px}
main{max-width:720px;margin:auto}.card{background:#151515;border:1px solid #2a2a2a;border-radius:18px;padding:20px;margin:14px 0}
h1{margin-top:0}.ok{color:#ffc928}label{display:block;font-weight:800;margin:14px 0 7px}
textarea,input{width:100%;box-sizing:border-box;background:#0f0f0f;color:#fff;border:1px solid #343434;border-radius:10px;padding:12px}
button{background:#ffc928;color:#171200;border:0;border-radius:10px;padding:11px 14px;font-weight:800;margin-top:8px}
small{color:#aaa;line-height:1.45;display:block}
</style>
</head>
<body>
<main>
  <div class="card">
    <h1><span class="ok">✓</span> Google Drive conectado</h1>
    <p>A pasta <strong>OS4 Cortes</strong> já está pronta no seu Drive.</p>
    <small>Copie os valores abaixo para os Secrets do GitHub. Esta página não salva os tokens.</small>

    <label>GOOGLE_REFRESH_TOKEN</label>
    <textarea id="refresh" rows="5" readonly>${esc(tokenData.refresh_token)}</textarea>
    <button onclick="navigator.clipboard.writeText(document.getElementById('refresh').value)">Copiar refresh token</button>

    <label>GOOGLE_DRIVE_FOLDER_ID</label>
    <input id="folder" readonly value="${esc(folderId)}">
    <button onclick="navigator.clipboard.writeText(document.getElementById('folder').value)">Copiar folder ID</button>

    <p><small>Também adicione GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET ao GitHub Secrets usando os mesmos valores configurados no Netlify.</small></p>
  </div>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
};

export const config = {
  path: "/api/google-drive/callback",
};
