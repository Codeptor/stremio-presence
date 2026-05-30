import { config } from "./config.js";

const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const MIDDOT = "·";
const EMDASH = "—";

const metaCache = new Map();

async function fetchMeta(type, id) {
  const key = `${type}/${id}`;
  const cached = metaCache.get(key);
  if (cached) return cached;

  const url = `${CINEMETA_BASE}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    throw new Error(`Cinemeta request failed for ${key}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Cinemeta returned HTTP ${res.status} for ${key}`);
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`Cinemeta returned invalid JSON for ${key}: ${err.message}`);
  }
  if (!body || !body.meta) {
    throw new Error(`Cinemeta response missing meta for ${key}`);
  }

  metaCache.set(key, body.meta);
  return body.meta;
}

function buildPosterUrl(imdbId, meta) {
  if (imdbId.startsWith("tt")) {
    return `https://images.metahub.space/poster/${config.posterSize}/${imdbId}/img`;
  }
  return meta.poster ?? null;
}

export async function resolveMeta(type, id, videoId) {
  const meta = await fetchMeta(type, id);
  const imdbId = id;
  const posterUrl = buildPosterUrl(imdbId, meta);
  const year = meta.releaseInfo ?? null;

  if (type === "series") {
    const video = Array.isArray(meta.videos)
      ? meta.videos.find((v) => v.id === videoId)
      : null;

    const season = video ? video.season : null;
    const episode = video ? video.episode : null;
    const episodeName = video ? video.name ?? null : null;

    let subtitle = null;
    if (season != null && episode != null) {
      subtitle = `S${season} ${MIDDOT} E${episode}`;
      if (episodeName) subtitle += ` ${EMDASH} ${episodeName}`;
    }

    return {
      title: meta.name,
      subtitle,
      posterUrl,
      imdbId,
      year,
      isSeries: true,
      season,
      episode,
      episodeName,
    };
  }

  const genre = Array.isArray(meta.genres) && meta.genres.length > 0 ? meta.genres[0] : null;
  let subtitle = year ?? "";
  if (genre) subtitle = `${subtitle} ${MIDDOT} ${genre}`;
  subtitle = subtitle.trim() || null;

  return {
    title: meta.name,
    subtitle,
    posterUrl,
    imdbId,
    year,
    isSeries: false,
    season: null,
    episode: null,
    episodeName: null,
  };
}
