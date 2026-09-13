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

function ownerHash(email) {
  return crypto.createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex");
}

function encryptionKey(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

function decryptToken(payload, secret) {
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const encrypted = Buffer.from(payload.data, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

async function getJSON(store, key) {
  const result = await store.get(key, { type: "json", consistency: "strong" });
  return result?.data ?? result ?? null;
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

function validYoutubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "youtu.be"].includes(host);
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Método não permitido." });
  }

  const secret = process.env.OS4_SESSION_SECRET;
  if (!secret) return json(500, { ok: false, error: "Sessão não configurada." });

  const cookies = parseCookies(event.headers.cookie || "");
  const user = verifySession(cookies.os4_session, secret);
  if (!user?.email) return json(401, { ok: false, error: "Não autenticado." });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "JSON inválido." });
  }

  const kind = String(body.kind || "").trim();
  if (!['transcribe', 'render'].includes(kind)) {
    return json(400, { ok: false, error: "Tipo de processamento inválido." });
  }

  const { getStore } = await import("@netlify/blobs");
  const configStore = getStore("os4-config");
  const jobsStore = getStore("os4-jobs");
  const configKey = `github:${ownerHash(user.email)}`;
  const githubConfig = await getJSON(configStore, configKey);

  if (!githubConfig?.token) {
    return json(409, { ok: false, error: "Conecte o GitHub na configuração inicial antes de processar." });
  }

  let githubToken;
  try {
    githubToken = decryptToken(githubConfig.token, secret);
  } catch {
    return json(500, { ok: false, error: "Não foi possível abrir a credencial do GitHub. Reconecte o GitHub." });
  }

  const requestId = crypto.randomUUID();
  const callbackToken = crypto.randomBytes(32).toString("base64url");
  const host = event.headers["x-forwarded-host"] || event.headers.host || "os4cortes.netlify.app";
  const proto = event.headers["x-forwarded-proto"] || "https";
  const callbackUrl = `${proto}://${host}/.netlify/functions/workflow-progress`;
  const repo = githubConfig.repo || "Lucascristao/os4cortes";

  let workflow;
  let inputs;

  if (kind === "transcribe") {
    const videoUrl = String(body.videoUrl || "").trim();
    if (!validYoutubeUrl(videoUrl)) {
      return json(400, { ok: false, error: "Cole uma URL válida do YouTube." });
    }
    workflow = "transcrever.yml";
    inputs = {
      video_url: videoUrl,
      request_id: requestId,
      callback_url: callbackUrl,
      callback_token: callbackToken,
    };
  } else {
    const folderId = String(body.folderId || "").trim();
    const videoFileId = String(body.videoFileId || "").trim();
    const transcriptJsonFileId = String(body.transcriptJsonFileId || "").trim();
    const cuts = Array.isArray(body.cuts) ? body.cuts : [];

    if (!folderId || !videoFileId || !transcriptJsonFileId) {
      return json(400, { ok: false, error: "A sessão de transcrição está incompleta. Transcreva o vídeo novamente." });
    }
    if (!cuts.length || cuts.length > 30) {
      return json(400, { ok: false, error: "O pacote precisa ter entre 1 e 30 cortes." });
    }

    const cutsJson = JSON.stringify(cuts);
    if (cutsJson.length > 60000) {
      return json(400, { ok: false, error: "O pacote de cortes ficou grande demais. Reduza os textos do pacote." });
    }

    workflow = "renderizar.yml";
    inputs = {
      request_id: requestId,
      folder_id: folderId,
      video_file_id: videoFileId,
      transcript_json_file_id: transcriptJsonFileId,
      cuts_json: cutsJson,
      callback_url: callbackUrl,
      callback_token: callbackToken,
    };
  }

  const now = new Date().toISOString();
  await jobsStore.setJSON(requestId, {
    ownerHash: ownerHash(user.email),
    callbackHash: crypto.createHash("sha256").update(callbackToken).digest("hex"),
    kind,
    status: "queued",
    stage: "fila",
    detail: "Enviado para o GitHub Actions",
    percent: 0,
    createdAt: now,
    updatedAt: now,
  });

  const dispatch = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "OS4-Cortes-Netlify",
    },
    body: JSON.stringify({ ref: "main", inputs }),
  });

  if (!dispatch.ok) {
    const detail = (await dispatch.text()).slice(0, 1000);
    await jobsStore.setJSON(requestId, {
      ownerHash: ownerHash(user.email),
      callbackHash: crypto.createHash("sha256").update(callbackToken).digest("hex"),
      kind,
      status: "error",
      stage: "github",
      detail: "O GitHub recusou o início do processamento.",
      percent: 0,
      error: detail,
      createdAt: now,
      updatedAt: new Date().toISOString(),
    });
    return json(502, { ok: false, error: `Não foi possível iniciar o GitHub Actions (${dispatch.status}).`, detail });
  }

  return json(202, { ok: true, requestId, status: "queued" });
};
