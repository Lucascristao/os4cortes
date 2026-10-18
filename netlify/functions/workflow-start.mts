import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
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

// Reject unusable plans before starting a runner. Python remains authoritative
// for voice directions, visual limits, transcript evidence and content checks.
function validEditorialShape(plan, clipStart, clipEnd) {
  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
  const validSpan = (value) => isObject(value) && Number.isFinite(value.start) && Number.isFinite(value.end) &&
    value.start >= 0 && value.end > value.start && value.start >= clipStart - 0.001 && value.end <= clipEnd + 0.001;
  if (!isObject(plan) || plan.version !== 1 || !Array.isArray(plan.scenes) ||
      plan.scenes.length < 2 || plan.scenes.length > 12) return false;
  const identifiers = new Set();
  let hasNarration = false;
  let hasClip = false;
  for (const scene of plan.scenes) {
    if (!isObject(scene) || typeof scene.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(scene.id) ||
        identifiers.has(scene.id)) return false;
    identifiers.add(scene.id);
    if (scene.kind === "clip") {
      if (!validSpan(scene)) return false;
      hasClip = true;
    } else if (scene.kind === "narration") {
      if (typeof scene.text !== "string" || !scene.text.trim() || scene.text.length > 1400 ||
          !validSpan(scene.background) || !Array.isArray(scene.evidence) || scene.evidence.length < 1 ||
          scene.evidence.length > 8 || !scene.evidence.every(validSpan) ||
          !isObject(scene.visual) || typeof scene.visual.title !== "string" ||
          !scene.visual.title.trim() || scene.visual.title.length > 100) return false;
      hasNarration = true;
    } else {
      return false;
    }
  }
  return hasNarration && hasClip;
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
  if (Object.hasOwn(body, "hasLowerThird") && typeof body.hasLowerThird !== "boolean") {
    return json(400, { ok: false, error: "A opção de tarja do vídeo precisa ser verdadeira ou falsa." });
  }
  const hasLowerThird = body.hasLowerThird === true;
  if (Object.hasOwn(body, "simpleCuts") && typeof body.simpleCuts !== "boolean") {
    return json(400, { ok: false, error: "A opção de corte simples precisa ser verdadeira ou falsa." });
  }
  // Cached old clients omit this field; the new UI explicitly sends false by default.
  const simpleCuts = !Object.hasOwn(body, "simpleCuts") || body.simpleCuts === true;

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
    if (!cuts.length) {
      return json(400, { ok: false, error: "O pacote precisa ter pelo menos um corte." });
    }

    for (const [index, cut] of cuts.entries()) {
      const seconds = (value) => {
        const text = String(value ?? "").trim().replace(/\s*:\s*/g, ":").replace(",", ".");
        if (!/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(text)) return NaN;
        const parts = text.split(":").map(Number);
        if (parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
        if (parts.length > 1 && parts[parts.length - 1] >= 60) return NaN;
        if (parts.length === 1) return parts[0];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return NaN;
      };
      const start = seconds(cut?.inicio);
      const end = seconds(cut?.fim);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return json(400, { ok: false, error: `Corte ${index + 1}: informe início e fim válidos, com fim maior que início.` });
      }
      if (!simpleCuts) {
        if (!validEditorialShape(cut?.editorial, start, end)) {
          return json(400, { ok: false, error: `Corte ${index + 1}: o formato autoral precisa de um plano editorial. Importe o pacote com narração ou marque corte simples.` });
        }
      }
    }

    const renderCuts = simpleCuts ? cuts.map(({ editorial, ...cut }) => cut) : cuts;
    let cutsJson = JSON.stringify(renderCuts);
    if (simpleCuts) {
      if (cutsJson.length > 60000) {
        return json(400, { ok: false, error: "O pacote de cortes ficou grande demais. Reduza os textos do pacote." });
      }
    } else {
      const rawBytes = Buffer.byteLength(cutsJson, "utf8");
      if (rawBytes > 512000) {
        return json(400, { ok: false, error: "O pacote autoral excede 512000 bytes. Divida o lote em pacotes menores." });
      }
      if (cutsJson.length > 60000 || rawBytes > 60000) {
        cutsJson = `gzip-base64:${gzipSync(cutsJson).toString("base64")}`;
        if (cutsJson.length > 60000) {
          return json(400, { ok: false, error: "O pacote autoral continua acima de 60000 caracteres após compressão. Divida o lote em pacotes menores." });
        }
      }
    }

    workflow = "renderizar.yml";
    inputs = {
      request_id: requestId,
      folder_id: folderId,
      video_file_id: videoFileId,
      transcript_json_file_id: transcriptJsonFileId,
      cuts_json: cutsJson,
      callback_url: callbackUrl,
      lower_third_mode: hasLowerThird ? "crop" : "off",
      lower_third_height: hasLowerThird ? "0.30" : "0",
      cut_mode: simpleCuts ? "simple" : "editorial",
    };
  }

  const now = new Date().toISOString();
  const jobBase = {
    ownerHash: ownerHash(user.email),
    callbackHash: crypto.createHash("sha256").update(derivedCallbackToken).digest("hex"),
    kind,
    hasLowerThird,
    simpleCuts,
    folderId: kind === "render" ? inputs.folder_id : null,
    totalCuts: kind === "render" ? body.cuts.length : null,
    status: "queued",
    stage: "fila",
    detail: "Enviado para o GitHub Actions",
    percent: 0,
    createdAt: now,
    updatedAt: now,
  };
  await jobsStore.setJSON(requestId, jobBase);
  if (kind === "render") {
    await jobsStore.setJSON(`publisher-folder:${inputs.folder_id}`, { requestId, ownerHash: jobBase.ownerHash });
  }

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
