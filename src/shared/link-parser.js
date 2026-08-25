const MAGNET_URI_RE = /magnet:\?[^\s"'<>]+/gi;
const MAGNET_HASH_RE = /xt=urn:bt(?:mh|ih):[A-Za-z0-9]{32,64}/i;
const ED2K_RE = /ed2k:\/\/\|file\|[^|]+\|\d+\|[a-fA-F0-9]{32}\|[^"\s<>]*/gi;
const THUNDER_RE = /thunder:\/\/[A-Za-z0-9+/=]{10,}/gi;
const HTTP_CANDIDATE_RE = /https?:\/\/[^\s"'<>]+/gi;
const HTTP_RE = /^https?:\/\/\S+$/i;

function decodeThunder(url) {
  try {
    let decoded = atob(url.slice("thunder://".length));
    if (decoded.startsWith("AA") && decoded.endsWith("ZZ")) {
      decoded = decoded.slice(2, -2);
    }
    return decoded || url;
  } catch {
    return url;
  }
}

export function normalizeLink(raw) {
  let source = (raw || "").trim();
  source = source.replace(/[),.;!?'”》]+$/, "");
  if (!source) return null;

  const magnet = source.match(MAGNET_URI_RE)?.[0];
  if (magnet && MAGNET_HASH_RE.test(magnet)) {
    return { type: "magnet", url: magnet };
  }

  const ed2k = source.match(ED2K_RE)?.[0];
  if (ed2k) return { type: "ed2k", url: ed2k };

  const thunder = source.match(THUNDER_RE)?.[0];
  if (thunder) {
    return { type: "thunder", url: thunder, inner: decodeThunder(thunder) };
  }

  if (HTTP_RE.test(source)) return { type: "http", url: source };
  return null;
}

export function extractLinks(text) {
  const source = text || "";
  const candidates = [
    ...source.matchAll(MAGNET_URI_RE),
    ...source.matchAll(ED2K_RE),
    ...source.matchAll(THUNDER_RE),
    ...source.matchAll(HTTP_CANDIDATE_RE),
  ].map((match) => match[0]);

  const seen = new Set();
  const links = [];
  for (const candidate of candidates) {
    const link = normalizeLink(candidate);
    if (!link || seen.has(link.url)) continue;
    seen.add(link.url);
    links.push(link);
  }
  return links;
}
