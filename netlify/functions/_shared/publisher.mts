import crypto from "node:crypto";

export function publisherToken(secret, folderId) {
  return crypto.createHmac("sha256", secret).update(`os4-publisher:${folderId}`).digest("hex");
}

export function readyKey(requestId, index) {
  return `publisher-ready:${requestId}:${index}`;
}

// Only renderer-produced, complete packages enter the publication feed.
export function readyCut(value) {
  if (!value || !Number.isSafeInteger(value.index) || value.index < 1) return null;
  const formato = value.formato === "16:9" ? "16:9" : "9:16";
  const source = value.files || {};
  const video = formato === "16:9" ? source.video || source.videoLegenda : source.videoLegenda;
  const validId = id => typeof id === "string" && /^[\w-]{1,200}$/.test(id);
  if (!validId(video?.id) || !validId(source.post?.id)) return null;
  const files = {};
  for (const key of ["video", "videoLegenda", "post", "capa", "srt"]) {
    if (validId(source[key]?.id)) files[key] = { id: source[key].id, url: `https://drive.google.com/file/d/${source[key].id}/view` };
  }
  return { index: value.index, titulo: String(value.titulo || `Corte ${value.index}`).slice(0, 500), formato,
    destino: formato === "16:9" ? "youtube" : "tiktok-instagram", ready: true, files };
}

export async function publicationCuts(store, requestId, job) {
  const complete = job.status === "completed" ? (job.result?.cuts || []).map(readyCut).filter(Boolean) : [];
  const records = [];
  const total = Number.isSafeInteger(job.totalCuts) && job.totalCuts > 0 ? job.totalCuts : 0;
  for (let offset = 0; offset < total; offset += 20) {
    records.push(...await Promise.all(Array.from({ length: Math.min(20, total-offset) },
      (_, i) => store.get(readyKey(requestId, offset+i+1), { type: "json" }))));
  }
  const cuts = new Map(records.map(readyCut).filter(Boolean).map(cut => [cut.index, cut]));
  for (const cut of complete) cuts.set(cut.index, cut);
  return [...cuts.values()].sort((a, b) => a.index - b.index);
}
