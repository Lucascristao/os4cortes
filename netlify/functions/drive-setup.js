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

exports.handler = async (event) => {
  const secret = process.env.OS4_SESSION_SECRET;
  if (!secret) return { statusCode: 500, body: "Sessão não configurada." };

  const cookies = parseCookies(event.headers.cookie || "");
  const user = verifySession(cookies.os4_session, secret);
  if (!user) {
    return {
      statusCode: 401,
      headers: { "content-type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, error: "Não autenticado" }),
    };
  }

  const available = Boolean(cookies.os4_setup);
  const checkOnly = String(event.queryStringParameters?.check || "") === "1";

  if (checkOnly) {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, available }),
    };
  }

  if (!available) {
    return {
      statusCode: 404,
      headers: { "content-type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, available: false }),
    };
  }

  let data;
  try {
    data = JSON.parse(cookies.os4_setup);
  } catch {
    return { statusCode: 400, body: "Configuração temporária inválida." };
  }

  return {
    statusCode: 200,
    multiValueHeaders: {
      "Set-Cookie": [
        "os4_setup=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        "os4_setup_done=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000",
      ],
    },
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({
      ok: true,
      available: true,
      refreshToken: data.refreshToken,
      folderId: data.folderId,
    }),
  };
};
