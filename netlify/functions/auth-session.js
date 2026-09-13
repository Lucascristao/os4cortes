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

function verifySession(token, secret) {
  try {
    const [encoded, sig] = String(token || "").split(".");
    if (!encoded || !sig) return null;
    const expected = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
    const left = Buffer.from(sig, "utf8");
    const right = Buffer.from(expected, "utf8");
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
    const payload = JSON.parse(fromBase64url(encoded));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function signSession(payload, secret) {
  const encoded = toBase64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
  return `${encoded}.${sig}`;
}

exports.handler = async (event) => {
  const secret = process.env.OS4_SESSION_SECRET;
  if (!secret) return { statusCode: 500, body: "Sessão não configurada." };

  const cookies = parseCookies(event.headers.cookie || "");
  const user = verifySession(cookies.os4_session, secret);

  const headers = {
    "content-type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };

  if (!user) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ authenticated: false }),
    };
  }

  // Sessão deslizante: cada acesso válido renova a permanência por até 400 dias.
  // Na prática, o OS4 Cortes só encerra a sessão pelo botão "Sair",
  // salvo se o navegador apagar cookies/dados do site.
  const renewedSession = signSession(
    {
      ...user,
      exp: Date.now() + SESSION_TTL_MS,
    },
    secret
  );

  return {
    statusCode: 200,
    headers,
    multiValueHeaders: {
      "Set-Cookie": [
        `os4_session=${renewedSession}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
      ],
    },
    body: JSON.stringify({
      authenticated: true,
      user: { email: user.email, name: user.name, picture: user.picture },
    }),
  };
};
