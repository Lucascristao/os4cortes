const crypto = require("crypto");

const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_MAX_AGE_SECONDS * 1000;

function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function toBase64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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

function validateState(state, secret) {
  try {
    const raw = fromBase64url(state);
    const [ts, sig] = raw.split(".");
    if (!ts || !sig) return false;
    const age = Date.now() - Number(ts);
    if (!Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000) return false;
    const expected = crypto.createHmac("sha256", secret).update(ts).digest("hex");
    const left = Buffer.from(sig, "utf8");
    const right = Buffer.from(expected, "utf8");
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function signSession(payload, secret) {
  const encoded = toBase64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
  return `${encoded}.${sig}`;
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
  if (!response.ok) throw new Error(`Drive API ${response.status}: ${await response.text()}`);
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
  if (found.files?.length) return found.files[0].id;

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
  const sessionSecret = process.env.OS4_SESSION_SECRET;
  const allowedEmail = (process.env.ALLOWED_GOOGLE_EMAIL || "").trim().toLowerCase();

  if (!clientId || !clientSecret || !sessionSecret) {
    return { statusCode: 500, body: "Credenciais OAuth/sessão não configuradas no Netlify." };
  }

  const { code, state, error } = event.queryStringParameters || {};
  if (error) return { statusCode: 400, body: `Google retornou erro: ${error}` };
  if (!code || !state || !validateState(state, clientSecret)) {
    return { statusCode: 400, body: "Retorno OAuth inválido ou expirado." };
  }

  const requestCookies = parseCookies(event.headers.cookie || "");
  const setupDone = requestCookies.os4_setup_done === "1";

  const host = event.headers["x-forwarded-host"] || event.headers.host || "os4cortes.netlify.app";
  const proto = event.headers["x-forwarded-proto"] || "https";
  const redirectUri = `${proto}://${host}/api/google-drive/callback`;

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
    return { statusCode: 500, body: "Não foi possível concluir o login Google." };
  }

  const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const user = await userResponse.json();
  if (!userResponse.ok || !user.email) {
    return { statusCode: 500, body: "Não foi possível identificar a conta Google." };
  }

  if (allowedEmail && user.email.toLowerCase() !== allowedEmail) {
    return {
      statusCode: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "Esta conta Google não está autorizada a acessar o OS4 Cortes.",
    };
  }

  const folderId = await ensureFolder(tokenData.access_token);
  const session = signSession(
    {
      sub: user.sub,
      email: user.email,
      name: user.name || user.email,
      picture: user.picture || "",
      exp: Date.now() + SESSION_TTL_MS,
    },
    sessionSecret
  );

  const cookies = [
    `os4_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];

  if (tokenData.refresh_token && !setupDone) {
    const setup = encodeURIComponent(JSON.stringify({
      refreshToken: tokenData.refresh_token,
      folderId,
    }));
    cookies.push(`os4_setup=${setup}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`);
  }

  return {
    statusCode: 302,
    multiValueHeaders: { "Set-Cookie": cookies },
    headers: {
      Location: "/?login=ok",
      "Cache-Control": "no-store",
    },
    body: "",
  };
};
