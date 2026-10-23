// Kino plugin: MissAV — v1.4.0 (CloudStream paths + getAndUnpack UUID)
// apiVersion 6. Mirrors configurable (missav.ai / .ws / .live / .re).

function log(...args) {
  try {
    kino.log(...args);
  } catch {
    // ignore
  }
}

function baseUrl() {
  const m = String(kino.config.get("mirror") || "https://missav.live").trim().replace(/\/+$/, "");
  return m || "https://missav.live";
}

function lang() {
  const l = String(kino.config.get("lang") || "en").toLowerCase();
  if (l === "cn" || l === "ja" || l === "en") return l;
  return "en";
}

function preferredQuality() {
  const q = String(kino.config.get("quality") || "hls").toLowerCase();
  if (q === "720" || q === "480" || q === "360") return q;
  return "hls";
}

function cleanText(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCharCode(Number(n));
      } catch {
        return "";
      }
    })
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toItem(v) {
  return {
    id: v.id,
    ref: v.id,
    title: v.title,
    kind: "movie",
    poster: v.thumb,
    quality: v.quality,
    overview: v.code || undefined,
    adult: true,
  };
}

/** Extract video code/slug from href like /en/ssis-001 or /dm58/en/hunta-703 */
function slugFromHref(href) {
  const h = String(href || "");
  const m =
    /\/(?:en|cn|ja)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/?(?:[?#]|$)/i.exec(h) ||
    /\/([a-zA-Z0-9]{2,}(?:-[a-zA-Z0-9]+)*)\/?(?:[?#]|$)/i.exec(h);
  if (!m) return "";
  const slug = m[1].toLowerCase();
  // skip known non-video paths
  if (
    /^(search|genres|actresses|makers|labels|new|release|today-hot|weekly-hot|monthly-hot|uncensored|dm\d+|login|account)$/i.test(
      slug
    )
  ) {
    return "";
  }
  return slug;
}

/**
 * Parse listing cards from MissAV HTML.
 * Stash-style structure:
 *   div.thumbnail.group > a[href] > img[data-src]
 *   title in nearby a text / title attr
 */
function normalizeHtml(html) {
  // Site sometimes prefixes classes: missav_media-thumbnail -> thumbnail
  return String(html || "").replace(/class="([^"]*)"/g, (_, c) => {
    return 'class="' + c.replace(/missav_media-/g, "") + '"';
  });
}

function coverUrl(id) {
  const code = String(id || "").toLowerCase().trim();
  if (!code) return undefined;
  // Current working cover CDN (2026): fourhoi.com
  return "https://fourhoi.com/" + encodeURIComponent(code) + "/cover-n.jpg";
}

function normalizeThumb(url) {
  if (!url) return undefined;
  let u = String(url).trim();
  if (u.startsWith("//")) u = "https:" + u;
  if (u.startsWith("/")) {
    try {
      u = baseUrl() + u;
    } catch {
      return undefined;
    }
  }
  if (!/^https?:\/\//i.test(u)) return undefined;
  if (/blank|placeholder|data:image|1x1|pixel|svg\+xml|logo|flag|icon/i.test(u)) {
    return undefined;
  }
  // Prefer full cover over tiny list thumb
  u = u.replace(/\/cover-t\.jpg/i, "/cover.jpg");
  u = u.replace(/\/cover-t\.webp/i, "/cover.webp");
  return u;
}

function parseVideoCards(html) {
  html = normalizeHtml(html);
  const items = [];
  const seen = new Set();

  // Split by thumbnail blocks (works with "thumbnail group" and partial matches)
  const parts = html.split(/class="[^"]*thumbnail[^"]*"/i);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].slice(0, 2500);

    const hrefM =
      /href="([^"]+)"/i.exec(block) ||
      /href='([^']+)'/i.exec(block);
    if (!hrefM) continue;
    const id = slugFromHref(hrefM[1]);
    if (!id || seen.has(id)) continue;

    let title = "";
    const titleAttr = /title="([^"]{2,250})"/i.exec(block);
    if (titleAttr) title = cleanText(titleAttr[1]);
    if (!title) {
      const aText = /<a[^>]*>([\s\S]*?)<\/a>/i.exec(block);
      if (aText) title = cleanText(aText[1].replace(/<[^>]+>/g, " "));
    }
    if (!title || title.length < 2) title = id.toUpperCase();

    let thumb;
    const candidates = [];
    // img data-src (lazy) — primary on MissAV
    let im;
    const imgRe = /<img\b[^>]*>/gi;
    while ((im = imgRe.exec(block)) !== null) {
      const tag = im[0];
      const attrs = [
        /data-src="([^"]+)"/i,
        /data-src='([^']+)'/i,
        /data-original="([^"]+)"/i,
        /src="([^"]+)"/i,
        /src='([^']+)'/i,
      ];
      for (const re of attrs) {
        const am = re.exec(tag);
        if (am) candidates.push(am[1]);
      }
      const ss = /(?:data-)?srcset="([^"]+)"/i.exec(tag);
      if (ss) {
        const first = ss[1].split(",")[0].trim().split(/\s+/)[0];
        if (first) candidates.push(first);
      }
    }
    // Also loose matches outside <img> (some templates)
    const loose = [
      /data-src="(https?:\/\/[^"]+)"/i,
      /(?:fourhoi|fivetiu|cdn\.missav)[^"\s]+\.(?:jpg|jpeg|webp|png)[^"\s]*/i,
    ];
    for (const re of loose) {
      const m = re.exec(block);
      if (m) candidates.push(m[1] || m[0]);
    }

    for (const c of candidates) {
      const n = normalizeThumb(c);
      if (n) {
        thumb = n;
        break;
      }
    }

    // Always fall back to fourhoi cover so posters are never blank
    if (!thumb) thumb = coverUrl(id);

    seen.add(id);
    items.push({
      id,
      title: title.slice(0, 200),
      thumb,
      code: id.toUpperCase(),
      quality: undefined,
    });
  }

  // Fallback link scan if split found nothing useful
  if (items.length < 3) {
    const linkRe =
      /href="((?:https?:\/\/[^"/]+)?\/(?:en|cn|ja)\/([a-zA-Z0-9][a-zA-Z0-9._-]*))"[^>]*(?:title="([^"]*)")?/gi;
    let lm;
    while ((lm = linkRe.exec(html)) !== null) {
      const id = lm[2].toLowerCase();
      if (!id || seen.has(id)) continue;
      if (/^(search|genres|actresses|makers|labels|new|release|today-hot|weekly-hot|monthly-hot)$/i.test(id))
        continue;
      const title = cleanText(lm[3] || id.toUpperCase());
      seen.add(id);
      items.push({
        id,
        title: title.slice(0, 200),
        thumb: coverUrl(id),
        code: id.toUpperCase(),
        quality: undefined,
      });
    }
  }

  return items;
}

async function fetchHtml(path) {
  const base = baseUrl();
  const url = path.startsWith("http") ? path : base + (path.startsWith("/") ? path : "/" + path);
  const r = await kino.fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,ja;q=0.8,zh;q=0.7",
      Referer: base + "/",
    },
    cookies: true,
    timeoutMs: 18000,
  });
  if (!r.ok) throw new Error("missav respondió " + r.status);
  return { html: r.text(), url: r.url };
}

function pagePath(suffix) {
  // suffix like "search/foo" or "new" or "genres/巨乳"
  const L = lang();
  const s = String(suffix || "").replace(/^\/+/, "");
  // Paths that already include language
  if (/^(en|cn|ja)\//i.test(s)) return "/" + s;
  return "/" + L + "/" + s;
}

/** Extract UUID + stream host from MissAV packed eval / page HTML. */

/** Dean Edwards / CloudStream-style packer unpack (best-effort). */
function getAndUnpack(html) {
  const src = String(html || "");
  // Already-plain UUID paths
  if (/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i.test(src)) {
    return src;
  }
  // eval(function(p,a,c,k,e,d)...'...'.split('|')
  const evalM =
    /eval\(function\(p,a,c,k,e,d\)[\s\S]{0,200}?'([^']+)'\.split\('\|'\)/i.exec(src) ||
    /}\('([^']+)',(\d+),(\d+),'([^']+)'\.split\('\|'\)/i.exec(src);
  if (!evalM) return src;
  try {
    // Prefer full payload string joined
    const payload = evalM[1] || "";
    const dict = (evalM[4] || payload).split("|");
    // Reconstruct readable by replacing \b word indices if classic packer
    if (evalM[4] && evalM[2] && evalM[3]) {
      const a = parseInt(evalM[2], 10);
      const c = parseInt(evalM[3], 10);
      let p = payload;
      // simplified: just return dictionary join for UUID search
      return p + " " + dict.join(" ");
    }
    return payload + " " + (evalM[0] || "");
  } catch (e) {
    return src;
  }
}

function extractStreamInfo(html) {
  // CloudStream MissAV: getAndUnpack then /uuid/ in unpacked text
  const unpacked = getAndUnpack(html);
  let uuid = null;
  let host = "surrit.com";

  // CS pattern: first UUID path segment after unpack
  const csId = /\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\//i.exec(
    unpacked
  );
  if (csId) {
    uuid = csId[1].toLowerCase();
  }

  // Strategy 1: eval(function(p,a,c,k,e,d){...}'...'.split('|')
  const evalMatch =
    /eval\(function\(p,a,c,k,e,d\)[\s\S]*?'([^']+)'\.split\('\|'\)/i.exec(html);
  if (evalMatch) {
    const parts = evalMatch[1].split("|");
    const hosts = ["surrit", "sixyik", "nineyu", "fourhoi"];
    let hasHost = false;
    for (const p of parts) {
      const low = p.toLowerCase();
      if (hosts.includes(low)) {
        host = low + ".com";
        hasHost = true;
        break;
      }
    }
    if (hasHost) {
      const uuidParts = [];
      for (const p of parts) {
        if (/^[0-9a-f]{8,12}$/i.test(p)) uuidParts.push(p.toLowerCase());
      }
      // Prefer classic 8-4-4-4-12 reconstruction from first 5 hex tokens
      if (uuidParts.length >= 5) {
        // Try forward order first
        const cand =
          uuidParts[0] +
          "-" +
          uuidParts[1] +
          "-" +
          uuidParts[2] +
          "-" +
          uuidParts[3] +
          "-" +
          uuidParts[4];
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cand)) {
          uuid = cand;
        }
      }
      // Alternate: reversed 5 segments (classic packer order)
      if (!uuid && uuidParts.length >= 5) {
        const r = uuidParts.slice(0, 5).reverse();
        const cand = r.join("-");
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cand)) {
          uuid = cand;
        }
      }
    }
  }

  // Strategy 2: m3u8|hex|...|com|surrit|https|video
  if (!uuid) {
    const packed = /m3u8\|([a-f0-9|]+)\|com\|(surrit|sixyik|nineyu|fourhoi)\|https\|video/i.exec(
      html
    );
    if (packed) {
      host = packed[2].toLowerCase() + ".com";
      const segs = packed[1].split("|").filter((p) => /^[a-f0-9]+$/i.test(p));
      if (segs.length >= 5) {
        const r = segs.slice(0, 5).reverse();
        uuid = r.join("-");
      }
    }
  }

  // Strategy 3: direct CDN URL in page
  if (!uuid) {
    const direct =
      /(?:surrit|sixyik|nineyu|fourhoi)\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
        html
      );
    if (direct) {
      uuid = direct[1].toLowerCase();
      const hm = /(surrit|sixyik|nineyu|fourhoi)\.com/i.exec(direct[0]);
      if (hm) host = hm[1].toLowerCase() + ".com";
    }
  }

  // Strategy 4: any UUID near video keywords
  if (!uuid) {
    const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    let m;
    const blacklist = /snaptrckr|user_uuid|popunder|banner|monitoring|crypto|randomUUID|generateUUID|google|facebook/i;
    while ((m = re.exec(html)) !== null) {
      const ctx = html.slice(Math.max(0, m.index - 100), m.index + 100);
      if (blacklist.test(ctx)) continue;
      uuid = m[0].toLowerCase();
      break;
    }
  }

  if (!uuid) return null;
  return {
    uuid,
    host,
    playlist: "https://" + host + "/" + uuid + "/playlist.m3u8",
  };
}

function qualityVariant(playlistUrl, quality) {
  if (!playlistUrl || quality === "hls") return playlistUrl;
  const base = playlistUrl.replace(/\/playlist\.m3u8.*$/i, "");
  const map = {
    "720": ["1280x720/video.m3u8", "720p/video.m3u8", "720p/playlist.m3u8"],
    "480": ["842x480/video.m3u8", "480p/video.m3u8", "480p/playlist.m3u8"],
    "360": ["640x360/video.m3u8", "360p/video.m3u8", "360p/playlist.m3u8"],
  };
  const opts = map[quality];
  if (!opts) return playlistUrl;
  return base + "/" + opts[0];
}

function streamHeaders(pageUrl) {
  const base = baseUrl();
  // Desktop Chrome UA — mobile/TV default UAs often get 403 on surrit
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Referer: pageUrl || base + "/",
    Origin: base,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

// ---- search ---------------------------------------------------------------

export async function search(query) {
  const q = String(query.q || "").trim();
  if (!q) return [];

  const page = query.cursor ? Math.max(0, Number(query.cursor) || 0) : 0;
  // MissAV: /en/search/QUERY  and ?page=N
  let path = pagePath("search/" + encodeURIComponent(q));
  if (page > 0) path += (path.includes("?") ? "&" : "?") + "page=" + (page + 1);

  let html;
  try {
    html = (await fetchHtml(path)).html;
  } catch (e) {
    log("search", e.message || e);
    throw kino.error("unavailable", e.message || "búsqueda falló");
  }

  const cards = parseVideoCards(html);
  const items = cards.slice(0, 100).map(toItem);
  const next = cards.length >= 12 ? String(page + 1) : undefined;
  return next ? { items, next } : items;
}

// ---- home -----------------------------------------------------------------

export async function home() {
  const rows = [];
  // Paths from CloudStream MissAV (ByAyzen / Cs-GizliKeyif) + our priorities
  const sections = [
    { id: "new", title: "Recientes", path: "/en/new?sort=published_at" },
    { id: "weekly", title: "Populares semana", path: "/dm169/en/weekly-hot?sort=weekly_views" },
    { id: "monthly", title: "Populares mes", path: "/dm263/en/monthly-hot?sort=views" },
    { id: "uncensored", title: "Uncensored Leak", path: "/dm628/en/uncensored-leak" },
    { id: "english-sub", title: "English Subtitles", path: "/en/english-subtitle" },
    { id: "fc2", title: "FC2", path: "/dm150/en/fc2" },
    { id: "heyzo", title: "HEYZO", path: "/dm1198483/en/heyzo" },
    { id: "caribbean", title: "Caribbeancom", path: "/dm3959622/en/caribbeancom" },
    { id: "1pondo", title: "1pondo", path: "/dm2469695/en/1pondo" },
    { id: "tokyohot", title: "Tokyo Hot", path: "/dm29/en/tokyohot" },
    { id: "pacopacomama", title: "Pacopacomama", path: "/dm1342558/en/pacopacomama" },
    { id: "madou", title: "Madou", path: "/dm35/en/madou" },
  ];

  for (const sec of sections) {
    try {
      const { html } = await fetchHtml(sec.path);
      const cards = parseVideoCards(html).slice(0, 36);
      if (cards.length) {
        rows.push({
          id: sec.id,
          title: sec.title,
          items: cards.map(toItem),
          ref: sec.path.replace(/^\//, "").split("?")[0],
        });
      }
    } catch (e) {
      log("home", sec.id, e.message || e);
    }
  }

  if (!rows.length) {
    throw kino.error(
      "unavailable",
      "Sin listados (prueba mirror missav.live / .ws en ajustes)"
    );
  }
  return rows;
}

// ---- browse ---------------------------------------------------------------

export async function browse(ref, cursor) {
  const page = cursor ? Math.max(0, Number(cursor) || 0) : 0;
  let path = pagePath(String(ref || "new").replace(/^\/+/, ""));
  if (page > 0) {
    path += (path.includes("?") ? "&" : "?") + "page=" + (page + 1);
  }

  let html;
  try {
    html = (await fetchHtml(path)).html;
  } catch (e) {
    log("browse", e.message || e);
    throw kino.error("unavailable", e.message || "browse falló");
  }

  const cards = parseVideoCards(html);
  const items = cards.map(toItem);
  const next = cards.length >= 12 ? String(page + 1) : undefined;
  return { items, next };
}

// ---- resolve --------------------------------------------------------------

export async function resolve(ref) {
  await Promise.resolve();

  let id = String(ref || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "");
  const fromPath = slugFromHref("/" + id) || slugFromHref(id);
  if (fromPath) id = fromPath;
  id = id.replace(/[^a-z0-9._-]/g, "");
  if (!id) throw kino.error("not_found", "ref vacío");

  const L = lang();
  const base = baseUrl();
  const pageCandidates = [
    base + pagePath(id),
    base + "/" + L + "/" + id,
    base + "/" + id,
    base + "/en/" + id,
    base + "/cn/" + id,
  ];

  // ---- Path A: hidden browser (real page headers → avoids surrit 403) ----
  const browserStream = await resolveViaBrowser(pageCandidates);
  if (browserStream) return browserStream;

  // ---- Path B: fetch + parse packed m3u8 (fast; may 403 on some TVs) ----
  let html = null;
  let finalUrl = null;

  for (const url of pageCandidates) {
    try {
      const r = await kino.fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: base + "/",
        },
        cookies: true,
        timeoutMs: 20000,
      });
      if (!r.ok) continue;
      const body = r.text();
      if (
        /just a moment|cf-browser-verification|challenge-platform/i.test(body) &&
        body.length < 12000
      ) {
        log("cloudflare challenge", url);
        continue;
      }
      html = body;
      finalUrl = r.url || url;
      if (/surrit|sixyik|nineyu|m3u8|eval\(function/i.test(body)) break;
    } catch (e) {
      log("resolve fetch", url, e.message || e);
    }
  }

  if (!html) {
    throw kino.error(
      "unavailable",
      "vídeo no encontrado (browser y fetch fallaron)"
    );
  }

  const info = extractStreamInfo(html);
  if (!info || !info.playlist) {
    log("no m3u8 for", id);
    throw kino.error("unavailable", "no se encontró el stream HLS");
  }

  const pref = preferredQuality();
  const playlist = info.playlist;
  const streamUrl = qualityVariant(playlist, pref);
  const headers = streamHeaders(finalUrl || base + "/");

  const alternatives = [];
  const addAlt = (url, label) => {
    if (url && url !== streamUrl) {
      alternatives.push({
        url,
        label,
        headers,
        mime: "application/x-mpegURL",
      });
    }
  };

  if (streamUrl !== playlist) addAlt(playlist, "HLS auto");
  for (const h of ["surrit.com", "sixyik.com", "nineyu.com"]) {
    if (h === info.host) continue;
    addAlt("https://" + h + "/" + info.uuid + "/playlist.m3u8", h.split(".")[0]);
  }
  for (const q of ["720", "480", "360"]) {
    if (q === pref) continue;
    addAlt(qualityVariant(playlist, q), q + "p");
  }

  return {
    url: streamUrl,
    mime: "application/x-mpegURL",
    headers,
    label: pref === "hls" ? "HLS" : pref + "p",
    alternatives: alternatives.length ? alternatives : undefined,
  };
}

/**
 * Open the MissAV watch page in the hidden WebView and capture the real
 * HLS request (URL + headers/cookies). This is the reliable path on Android TV
 * where plain Referer headers still get 403 from surrit.com.
 */
async function resolveViaBrowser(pageUrls) {
  if (!kino.browser || typeof kino.browser.capture !== "function") {
    log("browser.capture no disponible");
    return null;
  }

  let lastErr = null;
  for (const pageUrl of pageUrls) {
    try {
      log("browser.capture", pageUrl);
      const opts = {
        timeoutMs: 24000,
        autoplay: true,
        match: "\\.m3u8|surrit\\.com|sixyik\\.com|nineyu\\.com|/playlist",
        headers: {
          "Accept-Language": "en-US,en;q=0.9",
        },
      };

      const useAll = kino.browser.captureAll === true;
      if (useAll) {
        opts.captureAll = true;
        opts.alsoMatch = ["\\.key", "surrit\\.com", "sixyik\\.com", "nineyu\\.com"];
        opts.returnCookiesOnTimeout = true;
      }

      const page = await kino.browser.capture(pageUrl, opts);

      // Collect media from page.media and, if captureAll, from page.requests
      let media = (page.media || []).slice();
      if (useAll && page.requests && page.requests.length) {
        for (const req of page.requests) {
          if (!req || !req.url) continue;
          if (!/\.m3u8|surrit|sixyik|nineyu|playlist/i.test(req.url)) continue;
          if (media.some((m) => m.url === req.url)) continue;
          media.push({
            url: req.url,
            mime: /\.m3u8/i.test(req.url)
              ? "application/x-mpegURL"
              : "video/mp4",
            headers: req.headers || {},
          });
        }
      }

      if (!media.length) {
        log("browser: sin media en", pageUrl);
        continue;
      }

      // Prefer playlist.m3u8 on known CDNs
      media.sort((a, b) => {
        const score = (u) =>
          (/playlist\.m3u8/i.test(u) ? 5 : 0) +
          (/\.m3u8/i.test(u) ? 3 : 0) +
          (/(surrit|sixyik|nineyu)\.com/i.test(u) ? 2 : 0);
        return score(b.url) - score(a.url);
      });

      const primary = media[0];
      const headers = buildStreamHeaders(primary, page, pageUrl);

      // Log which header names we got (not values) for debugging 403s
      try {
        log(
          "browser headers",
          Object.keys(headers).join(","),
          "cookie?",
          !!(headers.Cookie || headers.cookie)
        );
      } catch (_) {}

      // Build alternatives: other captured media + same UUID on other CDNs
      const alternatives = [];
      const seen = new Set([primary.url]);
      for (let i = 1; i < media.length && alternatives.length < 6; i++) {
        const m = media[i];
        if (seen.has(m.url)) continue;
        seen.add(m.url);
        alternatives.push({
          url: m.url,
          label: altLabel(m.url, i),
          headers: buildStreamHeaders(m, page, pageUrl),
          mime: m.mime || (/\.m3u8/i.test(m.url) ? "application/x-mpegURL" : "video/mp4"),
        });
      }

      // UUID cross-CDN: surrit UUID often works on sixyik/nineyu
      const uuidM =
        /(?:surrit|sixyik|nineyu)\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
          primary.url
        );
      if (uuidM) {
        const uuid = uuidM[1];
        for (const host of ["surrit.com", "sixyik.com", "nineyu.com"]) {
          const u = "https://" + host + "/" + uuid + "/playlist.m3u8";
          if (seen.has(u)) continue;
          seen.add(u);
          alternatives.push({
            url: u,
            label: host.split(".")[0],
            headers,
            mime: "application/x-mpegURL",
          });
        }
      }

      const isHls =
        /\.m3u8/i.test(primary.url) || /mpegurl/i.test(primary.mime || "");
      log("browser OK", primary.url.slice(0, 90));
      return {
        url: primary.url,
        mime: primary.mime || (isHls ? "application/x-mpegURL" : "video/mp4"),
        headers,
        label: "Browser HLS",
        alternatives: alternatives.length ? alternatives : undefined,
      };
    } catch (e) {
      lastErr = e;
      const code = e && e.code;
      log("browser.capture error", code || "", e.message || e);
      if (code === "browser_unavailable" || code === "not_allowed") {
        return null;
      }
      continue;
    }
  }

  if (lastErr) log("browser path failed", lastErr.message || lastErr);
  return null;
}

/** Merge capture headers + page cookies + UA into a Stream headers object. */
function buildStreamHeaders(mediaItem, page, pageUrl) {
  const h = {};
  const src = (mediaItem && mediaItem.headers) || {};
  // Copy all allowed-looking headers (Kino already filtered to ~12)
  for (const k of Object.keys(src)) {
    if (!src[k]) continue;
    const low = k.toLowerCase();
    if (low === "range" || low === "accept-encoding" || low === "host") continue;
    h[k] = String(src[k]);
  }

  // Normalize Referer / Origin
  const referer =
    h.Referer ||
    h.referer ||
    (page && page.finalUrl) ||
    pageUrl ||
    baseUrl() + "/";
  h.Referer = referer;
  delete h.referer;

  if (!h.Origin && !h.origin) {
    try {
      const base = String(referer).replace(/^(https?:\/\/[^/]+).*/i, "$1");
      if (base.indexOf("http") === 0) h.Origin = base;
    } catch (_) {}
  } else if (h.origin && !h.Origin) {
    h.Origin = h.origin;
    delete h.origin;
  }

  // User-Agent: prefer page.userAgent (0.9.54+) so it matches cf_clearance
  const ua =
    (page && page.userAgent) ||
    h["User-Agent"] ||
    h["user-agent"] ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  h["User-Agent"] = ua;
  delete h["user-agent"];

  // Cookies: media headers may already include Cookie; also merge page.cookies
  let cookie = h.Cookie || h.cookie || "";
  if (page && page.cookies && typeof page.cookies === "object") {
    const parts = [];
    for (const name of Object.keys(page.cookies)) {
      const val = page.cookies[name];
      if (val == null || val === "") continue;
      parts.push(name + "=" + val);
    }
    if (parts.length) {
      const extra = parts.join("; ");
      cookie = cookie ? cookie + "; " + extra : extra;
    }
  }
  if (cookie) {
    h.Cookie = cookie;
    delete h.cookie;
  }

  if (!h.Accept) h.Accept = "*/*";
  if (!h["Accept-Language"]) h["Accept-Language"] = "en-US,en;q=0.9";

  return h;
}

function altLabel(url, i) {
  if (/sixyik/i.test(url)) return "sixyik";
  if (/nineyu/i.test(url)) return "nineyu";
  if (/surrit/i.test(url)) return "surrit";
  if (/\.m3u8/i.test(url)) return "HLS " + (i + 1);
  return "alt " + (i + 1);
}
