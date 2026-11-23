// FilmNox (filmnox.com) — Hindi/Bollywood download-index site.
// Chain: TMDB title/year -> DLE GET search -> post page -> go_link short link
// -> linkmake.in/view page -> filesdl.in/cloud pages -> "Direct Download"
// fffast.filesdl.in/zdownload.php link (Google Drive backend, byte-verified
// MKV). Movie only. Public community TMDB key (same as the 4KHDHub/MalluMV plugs).
// NOTE: the filesdl pages also list HubCloud / GDFlix / PixelDrain / GoFile
// mirrors — those are DELIBERATELY skipped: HubCloud+GDFlix are already
// covered by the live MoviesDrive plug and PixelDrain by the live PixelDrain
// plug. Only the fffast direct-download rows (a backend no live plug uses)
// are returned.
const TMDB_KEY = "439c478a771f35c05022f9feabcca01c";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE = "https://filmnox.com";

async function tmdbMeta(tmdbId, mediaType) {
  try {
    const r = await fetch("https://api.themoviedb.org/3/" + mediaType + "/" + tmdbId + "?api_key=" + TMDB_KEY, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const j = await r.json();
    const title = j.title || j.name || "";
    const date = j.release_date || j.first_air_date || "";
    return { title: title, year: date ? date.slice(0, 4) : "" };
  } catch (e) { return null; }
}

function titleScore(title, text) {
  const words = title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(function (w) { return w.length > 2; });
  if (!words.length) return 0;
  const hay = text.toLowerCase();
  let hit = 0;
  for (const w of words) { if (hay.indexOf(w) !== -1) hit++; }
  return hit / words.length;
}

function qualityOf(text) {
  const m = text.match(/(2160p|1080p|720p|480p|360p)/i);
  return m ? m[1].toLowerCase() : "";
}

// House row-format helpers (display-only; same streams, new name/title).
// Size on the site is a human string ("1.35 GB") — parse it to byte number.
function parseSizeBytes(text) {
  const m = String(text || "").match(/(\d+(?:\.\d+)?)\s*(gb|mb|kb)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  if (u === "gb") return Math.round(v * 1024 * 1024 * 1024);
  if (u === "mb") return Math.round(v * 1024 * 1024);
  return Math.round(v * 1024);
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + " MB";
  return bytes + " B";
}

function cleanName(name) {
  return String(name || "").replace(/\.(mkv|mp4|avi|webm|m3u8)$/i, "")
    .replace(/[\[\]()._-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extOf(fname) {
  const m = String(fname || "").match(/\.(mkv|mp4|avi|webm|m3u8)$/i);
  return m ? m[1].toUpperCase() : "";
}

// Language from the release filename; FilmNox is a Hindi/Bollywood index,
// so a filename with no language marker is still Hindi audio.
function languageOf(fname) {
  const t = String(fname || "");
  if (/\bdual\b/i.test(t)) return "Dual Audio";
  if (/\bmulti\b/i.test(t)) return "Multi Audio";
  return "Hindi";
}

function houseRow(meta, fname, sizeText, href) {
  const q = qualityOf(fname || href);
  const sizeBytes = parseSizeBytes(sizeText);
  const ext = extOf(fname);
  const lang = languageOf(fname);
  const clean = cleanName(fname);
  const title = (meta && meta.title) || "";
  const year = (meta && meta.year) || "";
  const name = (title + " " + year + " FilmNox" + (q ? " " + q : "")).replace(/\s+/g, " ").trim();
  const parts = [];
  if (q) parts.push("📺 " + q);
  if (lang) parts.push("🌐 " + lang);
  if (sizeBytes !== null) parts.push("💾 " + humanSize(sizeBytes));
  if (ext) parts.push("🎞️ " + ext);
  if (clean) parts.push("ℹ️ " + clean);
  const row = {
    url: href,
    name: name,
    title: parts.join("  |  "),
    headers: { "User-Agent": UA }
  };
  if (q) row.quality = q;
  if (sizeBytes !== null) row.size = sizeBytes;
  if (lang) row.language = lang;
  return row;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  if (mediaType !== "movie" && mediaType !== "tv") return [];
  try {
    const meta = await tmdbMeta(tmdbId, mediaType);
    if (!meta || !meta.title) return [];
    const cheerio = require("cheerio");
    // TV: match the season pack (e.g. "breaking-bad-s1-2008-...").
    // A season pack holds the whole season; the returned rows say so.
    const seasonRe = (mediaType === "tv" && season) ? new RegExp("(?:^|[^0-9])s0?" + season + "(?:[^0-9]|$)", "i") : null;
    const seasonText = (mediaType === "tv" && season) ? ("season " + season) : "";
    // 1. DLE GET search (POST times out from some seats; GET works).
    // Fall back to the first word: DLE search with a colon/subtitle
    // (e.g. "Pushpa: The Rise") can return nothing while "Pushpa" finds it.
    let cands = [];
    const queries = [meta.title];
    const firstWord = meta.title.split(/[\s:–—-]+/).filter(function (w) { return w.length > 2; })[0];
    if (firstWord && firstWord.toLowerCase() !== meta.title.toLowerCase()) queries.push(firstWord);
    for (const q of queries) {
      const sres = await fetch(BASE + "/index.php?do=search&subaction=search&story=" + encodeURIComponent(q), { headers: { "User-Agent": UA } });
      if (!sres.ok) continue;
      const html = await sres.text();
      const $ = cheerio.load(html);
      $("a[href]").each(function (_, el) {
        const href = $(el).attr("href");
        if (!href || href.indexOf(".html") === -1) return;
        if (href.indexOf("page-") !== -1 || href.indexOf("site-") !== -1) return;
        const text = $(el).text() + " " + href;
        let sc = titleScore(meta.title, text);
        if (meta.year && text.indexOf(meta.year) !== -1) sc += 0.3;
        if (seasonRe && seasonRe.test(href)) sc += 0.4;
        else if (seasonRe && seasonText && text.toLowerCase().indexOf(seasonText) !== -1) sc += 0.4;
        if (sc < 0.5) return;
        const url = href.indexOf("http") === 0 ? href : BASE + href;
        if (!cands.some(function (c) { return c.url === url; })) cands.push({ url: url, score: sc, text: text });
      });
      if (cands.length) break;
    }
    if (!cands.length) { console.log("[FilmNox] no title match for " + meta.title); return []; }
    // Best score first; skip a candidate whose text carries a different
    // year than the title (sequel / wrong-year guard).
    cands.sort(function (a, b) { return b.score - a.score; });
    const out = [];
    for (const cand of cands) {
      // Movie year guard: skip a candidate carrying a different year
      // (sequel / wrong-year). TV skips it: a season pack carries its own
      // season year, not the series' first-air year; the season token
      // in the score already picks the right season.
      if (mediaType === "movie" && meta.year) {
        const ym = cand.text.match(/\b(19|20)\d{2}\b/g) || [];
        if (ym.length && ym.indexOf(meta.year) === -1) continue;
      }
      const streams = await streamsForPost(cand.url, cheerio, meta);
      if (streams.length) return streams;
    }
    return out;
  } catch (e) {
    console.error("[FilmNox] " + (e && e.message ? e.message : e));
    return [];
  }
}

async function streamsForPost(best, cheerio, meta) {
    // 2. Post page -> go_link short link.
    const pres = await fetch(best, { headers: { "User-Agent": UA } });
    if (!pres.ok) return [];
    const phtml = await pres.text();
    const $p = cheerio.load(phtml);
    let goLink = null;
    $p("a[href*=\"/go_link/\"]").each(function (_, el) {
      if (!goLink) { const h = $p(el).attr("href"); goLink = h.indexOf("http") === 0 ? h : BASE + h; }
    });
    if (!goLink) { console.log("[FilmNox] no go_link on post page"); return []; }
    // 3. go_link -> linkmake.in/view page listing filesdl /cloud/ links.
    const lres = await fetch(goLink, { headers: { "User-Agent": UA, "Referer": best } });
    if (!lres.ok) return [];
    const lhtml = await lres.text();
    const $l = cheerio.load(lhtml);
    const cloudLinks = [];
    $l("a[href*=\"filesdl.in/cloud/\"]").each(function (_, el) {
      const h = $l(el).attr("href");
      if (h && cloudLinks.indexOf(h) === -1) cloudLinks.push(h);
    });
    if (!cloudLinks.length) { console.log("[FilmNox] no filesdl cloud links"); return []; }
    // 4. Each cloud page -> fffast direct-download link only.
    const out = [];
    for (const cl of cloudLinks) {
      try {
        const cres = await fetch(cl, { headers: { "User-Agent": UA, "Referer": lres.url } });
        if (!cres.ok) continue;
        const chtml = await cres.text();
        const $c = cheerio.load(chtml);
        let fname = "";
        $c("div.title").each(function (_, el) { if (!fname) fname = $c(el).text().trim(); });
        let size = "";
        $c("div.info").each(function (_, el) { const t = $c(el).text(); if (!size && t.indexOf("Size:") !== -1) size = t.replace("Size:", "").trim(); });
        $c("a[href*=\"fffast.filesdl.in/zdownload.php\"]").each(function (_, el) {
          const href = $c(el).attr("href");
          if (!href) return;
          out.push(houseRow(meta, fname, size, href));
        });
      } catch (e) { continue; }
    }
    return out;
}

if (typeof module !== "undefined" && module.exports) { module.exports = { getStreams }; }
globalThis.getStreams = getStreams;
