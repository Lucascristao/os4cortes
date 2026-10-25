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
const EDITORIAL_TOPICS = ["politics", "economy", "business", "humor", "general"];
const EDITORIAL_TONES = ["conversational", "provocative", "ironic", "playful", "explanatory", "serious"];
const EDITORIAL_INTENSITIES = ["low", "medium", "high"];
const COMMENTARY_MODES = ["support_source", "challenge_source", "direct_commentary"];
const COVER_TEMPLATES = ["01_central", "02_lateral", "03_close"];
const EDITORIAL_STYLES = ["classic", "paper", "motion_dark"];

function coverShapeError(cover) {
  if (!cover || typeof cover !== "object" || Array.isArray(cover)) return "cover precisa ser um objeto JSON.";
  if (Object.keys(cover).length !== 3 || !["version", "template_id", "title"].every(key => Object.hasOwn(cover, key))) {
    return "cover precisa conter somente version, template_id e title.";
  }
  if (cover.version !== 1) return "cover.version precisa ser 1.";
  // Retired selections are accepted only as legacy input and migrated before dispatch.
  if (!COVER_TEMPLATES.includes(cover.template_id) && cover.template_id !== "04_duas_pessoas") return "cover.template_id precisa ser 01_central, 02_lateral ou 03_close.";
  if (typeof cover.title !== "string" || !cover.title.trim() || Array.from(cover.title).length > 60
      || /[\p{C}\u2028\u2029<>`]|\*\*|__|\[[^\]]*\]\(/u.test(cover.title)) {
    return "cover.title precisa ser texto simples em uma linha, não vazio, com até 60 caracteres.";
  }
  return null;
}

function editorialShapeError(plan, clipStart, clipEnd) {
  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
  const invalid = (detail) => `plano editorial inválido: ${detail}`;
  const spanError = (value, field) => {
    if (!isObject(value) || !Number.isFinite(value.start) || !Number.isFinite(value.end) ||
        value.start < 0 || value.end <= value.start) {
      return `o campo ${field} precisa ter start e end numéricos, com start ≥ 0 e end maior que start.`;
    }
    if (value.start < clipStart - 0.001 || value.end > clipEnd + 0.001) {
      return `o campo ${field} (${value.start}s a ${value.end}s) está fora do intervalo do corte ` +
        `(início ${clipStart}s; fim ${clipEnd}s). Corrija início/fim ou os tempos da cena.`;
    }
    return null;
  };
  if (plan == null) {
    return "o formato autoral precisa de um plano editorial. Importe o pacote com narração ou marque corte simples.";
  }
  if (!isObject(plan)) return invalid("editorial precisa ser um objeto.");
  if (plan.version !== 1) return invalid("o campo version precisa ser o número 1.");
  if (Object.hasOwn(plan, "visual_style") && !EDITORIAL_STYLES.includes(plan.visual_style)) {
    return invalid("o campo visual_style precisa ser classic, paper ou motion_dark.");
  }
  if (Object.hasOwn(plan, "intent")) {
    const intent = plan.intent;
    if (!isObject(intent)) return invalid("o campo intent precisa ser um objeto.");
    const fields = ["mode", "source_point", "target", "contribution"];
    if (Object.keys(intent).some((field) => !fields.includes(field))) {
      return invalid("o campo intent contém uma propriedade não suportada.");
    }
    if (!COMMENTARY_MODES.includes(intent.mode)) return invalid("o campo intent.mode contém um papel de comentário desconhecido.");
    for (const field of ["source_point", "contribution"]) {
      if (typeof intent[field] !== "string" || !intent[field].trim() || intent[field].length > 240) {
        return invalid(`o campo intent.${field} precisa conter texto de até 240 caracteres.`);
      }
    }
    if (typeof intent.target !== "string" || intent.target.length > 240) {
      return invalid("o campo intent.target precisa ser uma string de até 240 caracteres; pode ser vazia quando não houver alvo de cobrança.");
    }
  }
  if (Object.hasOwn(plan, "profile")) {
    const profile = plan.profile;
    if (!isObject(profile)) return invalid("o campo profile precisa ser um objeto.");
    const fields = ["perspective", "topic", "tone", "intensity", "angle", "audience_question"];
    if (Object.keys(profile).some((field) => !fields.includes(field))) {
      return invalid("o campo profile contém uma propriedade não suportada.");
    }
    if (profile.perspective !== "right") return invalid('o campo profile.perspective precisa ser "right".');
    if (!EDITORIAL_TOPICS.includes(profile.topic)) return invalid("o campo profile.topic contém um tema desconhecido.");
    if (!EDITORIAL_TONES.includes(profile.tone)) return invalid("o campo profile.tone contém um tom desconhecido.");
    if (!EDITORIAL_INTENSITIES.includes(profile.intensity)) return invalid("o campo profile.intensity contém uma intensidade desconhecida.");
    if (typeof profile.angle !== "string" || !profile.angle.trim() || profile.angle.length > 240) {
      return invalid("o campo profile.angle precisa descrever a leitura do corte em até 240 caracteres.");
    }
    if (typeof profile.audience_question !== "string" || profile.audience_question.length > 240) {
      return invalid("o campo profile.audience_question precisa ser uma string de até 240 caracteres; use vazia quando não couber pergunta.");
    }
  }
  if (!Array.isArray(plan.scenes) || plan.scenes.length < 2 || plan.scenes.length > 12) {
    return invalid("o campo scenes precisa ter entre 2 e 12 cenas.");
  }
  const identifiers = new Set();
  let hasNarration = false;
  let hasClip = false;
  for (const [index, scene] of plan.scenes.entries()) {
    const location = `cena ${index + 1}${typeof scene?.id === "string" ? ` (${scene.id})` : ""}`;
    const sceneError = (detail) => invalid(`${location}: ${detail}`);
    if (!isObject(scene) || typeof scene.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(scene.id)) {
      return sceneError("o campo id precisa ter entre 1 e 40 letras, números, hífens ou sublinhados, começando com letra ou número.");
    }
    if (identifiers.has(scene.id)) return sceneError("o campo id está repetido no plano.");
    identifiers.add(scene.id);
    if (scene.kind === "clip") {
      const error = spanError(scene, "start/end");
      if (error) return sceneError(error);
      hasClip = true;
    } else if (scene.kind === "narration") {
      if (Object.hasOwn(scene, "tts")) {
        if (!isObject(scene.tts)) return sceneError("o campo tts precisa ser um objeto.");
        if (Object.hasOwn(scene.tts, "tone") && !EDITORIAL_TONES.includes(scene.tts.tone)) {
          return sceneError("o campo tts.tone contém um tom desconhecido.");
        }
        if (Object.hasOwn(scene.tts, "intensity") && !EDITORIAL_INTENSITIES.includes(scene.tts.intensity)) {
          return sceneError("o campo tts.intensity contém uma intensidade desconhecida.");
        }
      }
      if (typeof scene.text !== "string" || !scene.text.trim() || scene.text.length > 1400) {
        return sceneError("o campo text precisa conter a narração, com até 1400 caracteres.");
      }
      const backgroundError = spanError(scene.background, "background");
      if (backgroundError) return sceneError(backgroundError);
      if (!Array.isArray(scene.evidence) || scene.evidence.length < 1 || scene.evidence.length > 8) {
        return sceneError("o campo evidence precisa ter entre 1 e 8 trechos de referência.");
      }
      for (const [evidenceIndex, evidence] of scene.evidence.entries()) {
        const error = spanError(evidence, `evidence[${evidenceIndex}]`);
        if (error) return sceneError(error);
      }
      if (!isObject(scene.visual) || typeof scene.visual.title !== "string" ||
          !scene.visual.title.trim() || scene.visual.title.length > 100) {
        return sceneError("o campo visual.title precisa conter um título de até 100 caracteres.");
      }
      if (Object.hasOwn(scene.visual, "motion")) {
        const motion = scene.visual.motion;
        if (!isObject(motion) || Object.keys(motion).some((key) => !["layout", "icon", "emphasis", "beats"].includes(key))) {
          return sceneError("visual.motion aceita somente layout, icon, emphasis e beats.");
        }
        if (Object.hasOwn(motion, "layout") && !["source_card", "statement", "comparison", "quote", "number", "timeline"].includes(motion.layout)) {
          return sceneError("visual.motion.layout não existe no motor.");
        }
        if (Object.hasOwn(motion, "icon") && !["line-md:chat", "line-md:alert-circle", "line-md:confirm-circle", "line-md:clipboard-check"].includes(motion.icon)) {
          return sceneError("visual.motion.icon não existe no catálogo Line MD local.");
        }
        if (Object.hasOwn(motion, "emphasis") && (typeof motion.emphasis !== "string" || motion.emphasis.length > 50 ||
            !scene.visual.title.toLocaleLowerCase().includes(motion.emphasis.toLocaleLowerCase()))) {
          return sceneError("visual.motion.emphasis deve repetir um trecho literal do visual.title.");
        }
        if (Object.hasOwn(motion, "beats")) {
          const beats = motion.beats;
          if (!Array.isArray(beats) || beats.length < 1 || beats.length > 8) {
            return sceneError("visual.motion.beats: informe de 1 a 8 beats visuais.");
          }
          const validTypes = ["headline", "metric", "strike_comparison", "comparison", "quote_card", "document_card", "source_focus"];
          const validModes = ["window", "bottom", "hidden", "side"];
          for (const [beatIndex, beat] of beats.entries()) {
            if (!isObject(beat)) {
              return sceneError(`visual.motion.beats[${beatIndex}] deve ser um objeto.`);
            }
            if (Object.hasOwn(beat, "type") && !validTypes.includes(beat.type)) {
              return sceneError(`visual.motion.beats[${beatIndex}].type não existe no motor.`);
            }
            if (Object.hasOwn(beat, "video_mode") && !validModes.includes(beat.video_mode)) {
              return sceneError(`visual.motion.beats[${beatIndex}].video_mode desconhecido.`);
            }
            if (Object.hasOwn(beat, "anchor") && typeof beat.anchor !== "string") {
              return sceneError(`visual.motion.beats[${beatIndex}].anchor deve ser texto.`);
            }
          }
        }
      }
      hasNarration = true;
    } else {
      return sceneError('o campo kind precisa ser "clip" ou "narration".');
    }
  }
  return hasNarration && hasClip ? null : invalid("inclua pelo menos uma cena de narração e uma cena do vídeo original.");
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
  if (Object.hasOwn(body, "burnCaptions") && typeof body.burnCaptions !== "boolean") {
    return json(400, { ok: false, error: "A opção de queimar legendas precisa ser verdadeira ou falsa." });
  }
  const burnCaptions = !Object.hasOwn(body, "burnCaptions") || body.burnCaptions === true;
  if (Object.hasOwn(body, "editorialStyle") && !EDITORIAL_STYLES.includes(body.editorialStyle)) {
    return json(400, { ok: false, error: "O visual dos vídeos autorais precisa ser classic, paper ou motion_dark." });
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
    if (!cuts.length) {
      return json(400, { ok: false, error: "O pacote precisa ter pelo menos um corte." });
    }

    const normalizedCuts = [];
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
      if (Object.hasOwn(cut || {}, "cover")) {
        const error = coverShapeError(cut.cover);
        if (error) return json(400, { ok: false, error: `Corte ${index + 1}: ${error}` });
      }
      if (!simpleCuts) {
        const error = editorialShapeError(cut?.editorial, start, end);
        if (error) {
          return json(400, { ok: false, error: `Corte ${index + 1}: ${error}` });
        }
      }
      if (cut.cover?.template_id === "04_duas_pessoas") {
        const originalSeconds = !simpleCuts && cut.editorial
          ? Number(cut.editorial.scenes.filter(scene => scene.kind === "clip")
            .reduce((total, scene) => total + scene.end - scene.start, 0).toFixed(6))
          : Number((end - start).toFixed(6));
        const horizontal = String(cut.formato || "").trim().toLowerCase() === "16:9"
          || String(cut.destino || cut.plataforma || "").trim().toLowerCase() === "youtube"
          || originalSeconds > 180;
        normalizedCuts.push({ ...cut, cover: { ...cut.cover, template_id: horizontal ? "02_lateral" : "01_central" } });
      } else {
        normalizedCuts.push(cut);
      }
    }

    const renderCuts = normalizedCuts.map((cut) => {
      if (simpleCuts) {
        const { editorial, ...simpleCut } = cut;
        return simpleCut;
      }
      if (!Object.hasOwn(body, "editorialStyle")) return cut;
      // Only the render copy receives the batch choice. Imported plans and
      // legacy packages remain unchanged, including absence of the default.
      const { visual_style, ...editorial } = cut.editorial;
      return { ...cut, editorial: body.editorialStyle === "paper" || body.editorialStyle === "motion_dark" ? { ...editorial, visual_style: body.editorialStyle } : editorial };
    });
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
      burn_captions: burnCaptions ? "true" : "false",
    };
  }

  const now = new Date().toISOString();
  const jobBase = {
    ownerHash: ownerHash(user.email),
    callbackHash: crypto.createHash("sha256").update(derivedCallbackToken).digest("hex"),
    kind,
    hasLowerThird,
    simpleCuts,
    burnCaptions,
    ...(Object.hasOwn(body, "editorialStyle") ? { editorialStyle: body.editorialStyle } : {}),
    folderId: kind === "render" ? inputs.folder_id : null,
    totalCuts: kind === "render" ? body.cuts.length : null,
    status: "queued",
    stage: "fila",
    detail: "Enviado para o GitHub Actions",
    percent: 0,
    completedCount: 0,
    failedCount: 0,
    consecutiveFailures: 0,
    failureHistory: [],
    pendingDecision: null,
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
