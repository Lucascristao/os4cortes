import crypto from "node:crypto";
import { blobStore, safeHandler } from "./_shared/platform.mts";

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

function callbackToken(sharedSecret, requestId) {
  return crypto.createHmac("sha256", sharedSecret).update(`os4-progress:${requestId}`).digest("hex");
}

async function getJSON(store, key) {
  return await store.get(key, { type: "json" });
}

function json(statusCode, body) {
  return Response.json(body, { status: statusCode, headers: { "Cache-Control": "no-store" } });
}

function validYoutubeUrl(value) {
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

export default safeHandler(async (request, context) => {
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Método não permitido." });
  }

  const secret = Netlify.env.get("OS4_SESSION_SECRET");
  const googleClientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  if (!secret || !googleClientSecret) {
    return json(500, { ok: false, error: "Credenciais internas não configuradas." });
  }

  const cookies = parseCookies(request.headers.get("cookie") || "");
  const user = verifySession(cookies.os4_session, secret);
  if (!user?.email) return json(401, { ok: false, error: "Não autenticado." });

  let body;
  try {
    body = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
  } catch {
    return json(400, { ok: false, error: "JSON inválido." });
  }

  const kind = String(body.kind || "").trim();
  if (!["transcribe", "render"].includes(kind)) {
    return json(400, { ok: false, error: "Tipo de processamento inválido." });
  }

  const configStore = blobStore("os4-config", context);
  const jobsStore = blobStore("os4-jobs", context);
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
  const derivedCallbackToken = callbackToken(googleClientSecret, requestId);
  const callbackUrl = new URL("/.netlify/functions/workflow-progress", request.url).href;
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

    for (const [index, cut] of cuts.entries()) {
      const seconds = (value) => {
        const text = String(value ?? "").trim();
        if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(text)) return NaN;
        const parts = text.split(":").map(Number);
        if (parts.slice(1).some((part) => part >= 60)) return NaN;
        return parts.reduce((total, part) => total * 60 + part, 0);
      };
      const start = seconds(cut?.inicio);
      const end = seconds(cut?.fim);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return json(400, { ok: false, error: `Corte ${index + 1}: informe início e fim válidos, com fim maior que início.` });
      }
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
    };
  }

  const now = new Date().toISOString();
  const jobBase = {
    ownerHash: ownerHash(user.email),
    callbackHash: crypto.createHash("sha256").update(derivedCallbackToken).digest("hex"),
    kind,
    status: "queued",
    stage: "fila",
    detail: "Enviado para o GitHub Actions",
    percent: 0,
    createdAt: now,
    updatedAt: now,
  };
  await jobsStore.setJSON(requestId, jobBase);

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
      ...jobBase,
      status: "error",
      stage: "github",
      detail: "O GitHub recusou o início do processamento.",
      error: detail,
      updatedAt: new Date().toISOString(),
    });
    return json(502, { ok: false, error: `Não foi possível iniciar o GitHub Actions (${dispatch.status}).`, detail });
  }

  return json(202, { ok: true, requestId, status: "queued" });
});
