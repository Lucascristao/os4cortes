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

function keyForEmail(email) {
  return `github:${crypto.createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex")}`;
}

function encryptionKey(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptToken(token, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

async function getJSON(store, key) {
  return await store.get(key, { type: "json" });
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    const secret = process.env.OS4_SESSION_SECRET;
    if (!secret) return json(500, { ok: false, error: "Sessão não configurada." });

    const cookies = parseCookies(event.headers.cookie || "");
    const user = verifySession(cookies.os4_session, secret);
    if (!user?.email) return json(401, { ok: false, error: "Não autenticado." });

    const { connectLambda, getStore } = await import("@netlify/blobs");
    connectLambda(event);
    const store = getStore("os4-config", { consistency: "strong" });
    const key = keyForEmail(user.email);

    if (event.httpMethod === "GET") {
      const config = await getJSON(store, key);
      return json(200, { ok: true, connected: Boolean(config?.token) });
    }

    if (event.httpMethod === "DELETE") {
      await store.delete(key);
      return json(200, { ok: true, connected: false });
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Método não permitido." });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "JSON inválido." });
    }

    const token = String(body.token || "").trim();
    if (!token || token.length < 20) {
      return json(400, { ok: false, error: "Token do GitHub inválido." });
    }

    const repo = "Lucascristao/os4cortes";
    const check = await fetch(`https://api.github.com/repos/${repo}/actions/workflows`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OS4-Cortes-Netlify",
      },
    });

    if (!check.ok) {
      const text = await check.text();
      return json(400, {
        ok: false,
        error: `O GitHub recusou o token (${check.status}). Confira acesso ao repositório e Actions: Read and write.`,
        detail: text.slice(0, 500),
      });
    }

    await store.setJSON(key, {
      token: encryptToken(token, secret),
      repo,
      updatedAt: new Date().toISOString(),
    });

    return json(200, { ok: true, connected: true });
  } catch (error) {
    console.error("github-setup:", error);
    return json(500, {
      ok: false,
      error: "Falha interna ao salvar a conexão com o GitHub.",
      detail: String(error?.message || error).slice(0, 500),
    });
  }
};
