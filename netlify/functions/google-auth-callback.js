const crypto = require("crypto");

function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function validateState(state, secret) {
  try {
    const raw = fromBase64url(state);
    const [ts, sig] = raw.split(".");
    if (!ts || !sig) return false;

    const age = Date.now() - Number(ts);
    if (!Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000) {
      return false;
    }

    const expected = crypto.createHmac("sha256", secret).update(ts).digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(sig, "utf8"),
      Buffer.from(expected, "utf8")
    );
  } catch {
    return false;
  }
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function driveFetch(accessToken, url, options = {}) {
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

async function ensureFolder(accessToken) {
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

exports.handler = async (event) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      statusCode: 500,
      body: "Credenciais OAuth do Google não configuradas no Netlify.",
    };
  }

  const { code, state, error } = event.queryStringParameters || {};

  if (error) {
    return {
      statusCode: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: `Google retornou erro: ${error}`,
    };
  }

  if (!code || !state || !validateState(state, clientSecret)) {
    return {
      statusCode: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "Retorno OAuth inválido ou expirado. Inicie a conexão novamente.",
    };
  }

  const host =
    event.headers["x-forwarded-host"] ||
    event.headers.host ||
    "os4cortes.netlify.app";
  const proto = event.headers["x-forwarded-proto"] || "https";
  const redirectUri =
    `${proto}://${host}/.netlify/functions/google-auth-callback`;

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

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(tokenData, null, 2),
    };
  }

  if (!tokenData.refresh_token) {
    return {
      statusCode: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body:
        "O Google não devolveu refresh_token. Revogue o acesso do app na conta Google e tente novamente.",
    };
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
main{max-width:720px;margin:auto}
.card{background:#151515;border:1px solid #2a2a2a;border-radius:18px;padding:20px;margin:14px 0}
h1{margin-top:0}.ok{color:#ffc928}
label{display:block;font-weight:800;margin:14px 0 7px}
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

  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow",
    },
    body: html,
  };
};
