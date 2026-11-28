// DonghuaStream — Chinese anime (donghua) with multi-language
// subtitles from donghuastream.org, resolved on-device. PlugX v1.0.0.
// The site is a WordPress/AnimeStream catalogue. A title is found
// through the site's own WP REST search (/wp-json/wp/v2/search),
// which returns the series post under /anime/<slug>/. The series
// page lists episode posts at the root:
//   /<base>-episode-<n>-multiple-subtitles/
//   /<base>-season-<s>-episode-<e>-ep-<absolute>-multiple-subtitles/
// Episode numbering on the site is absolute across a series (its
// own "ep" number), so the plug converts TMDB season/episode to an
// absolute number with TMDB's per-season episode counts, and also
// honours an explicit season marker in the slug when present.
// An episode page carries a server <select class="mirror"> whose
// option values are base64-encoded iframe HTML (the theme's own
// format). Servers seen: Dailymotion ("Multiple Subtitles"),
// Rumble, StreamPlay and OK.ru ("English"). This plug resolves the
// two hosts whose chains are plain fetches:
//   - Dailymotion: the public player metadata endpoint
//     (www.dailymotion.com/player/metadata/video/<id>) issues the
//     signed HLS url and its served quality ladder, so the
//     claimed quality is the ladder's own maximum. The
//     metadata also lists the video's subtitle tracks — the HLS
//     carries them, which is the site's "Multiple Subtitles".
//   - OK.ru: the embed page's data-options JSON carries direct
//     MP4 urls per quality tier; tiers are claimed only under
//     OK.ru's own ladder names (mobile tier = no claim).
// Rumble (bot-check page) and StreamPlay (packed player script)
// are not resolved, so they produce no rows. Movies live on the
// series post as root-level "part" watch posts; part 1 is used.
// Audio on this catalogue is Mandarin; rows say so, and the title
// carries the site's own subtitle marking. No size is known, so
// none is shown. Every stage fails to [] with one truthful
// console.error per failed route.

var SITE = "https://donghuastream.org";
var TMDB_KEY = "439c478a771f35c05022f9feabcca01c";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var TAG = "[DonghuaStream]";

var OK_TIERS = {
  low: "240p", medium: "360p", high: "480p", hd: "720p",
  fullhd: "1080p", quadhd: "1440p", ultra: "2160p"
  // "mobile" intentionally unmapped: no quality claim.
};

/** Fetch text, never throws — null on any failure. */
function fetchText(url, headers) {
  return fetch(url, { redirect: "follow", headers: headers || {} })
    .then(function (r) {
      if (!r.ok) return null;
      return r.text().catch(function () { return null; });
    })
    .catch(function () { return null; });
}

/** Fetch JSON, never throws — null on any failure. */
function fetchJson(url, headers) {
  return fetch(url, { redirect: "follow", headers: headers || {} })
    .then(function (r) {
      if (!r.ok) return null;
      return r.json().catch(function () { return null; });
    })
    .catch(function () { return null; });
}

/** Decode the small set of HTML entities these pages emit. */
function decodeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Lowercase, fold common accents, keep [a-z0-9 ] only. */
function normalizeTitle(s) {
  var t = String(s || "").toLowerCase();
  var fold = { "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "ā": "a", "ă": "a", "ą": "a",
    "è": "e", "é": "e", "ê": "e", "ë": "e", "ē": "e", "ì": "i", "í": "i", "î": "i", "ï": "i", "ī": "i",
    "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o", "ō": "o", "ù": "u", "ú": "u", "û": "u", "ü": "u", "ū": "u",
    "ñ": "n", "ç": "c", "ý": "y", "ÿ": "y" };
  t = t.replace(/[àáâãäāăąèéêëēìíîïīòóôõöōùúûüūñçýÿ]/g, function (c) { return fold[c] || c; });
  return t.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function isLatinTitle(s) {
  return !/[　-鿿豈-﫿＀-￯]/.test(String(s || ""));
}

/** TMDB id -> { title, year, altTitles, seasons }, or null. */
function tmdbMeta(tmdbId, mediaType) {
  var kind = mediaType === "tv" ? "tv" : "movie";
  var url = "https://api.themoviedb.org/3/" + kind + "/" + tmdbId +
    "?api_key=" + TMDB_KEY + "&append_to_response=alternative_titles";
  return fetchJson(url, { "User-Agent": UA }).then(function (j) {
    if (!j || j.success === false) return null;
    var title = j.title || j.name || "";
    if (!title) return null;
    var alts = [];
    var rawAlts = [];
    if (j.alternative_titles) rawAlts = j.alternative_titles.results || j.alternative_titles.titles || [];
    for (var i = 0; i < rawAlts.length; i++) {
      var a = rawAlts[i] && rawAlts[i].title;
      if (a && a !== title && isLatinTitle(a) && alts.indexOf(a) === -1) alts.push(a);
    }
    var seasons = [];
    if (Array.isArray(j.seasons)) {
      for (var k = 0; k < j.seasons.length; k++) {
        var s = j.seasons[k];
        if (s && typeof s.season_number === "number") {
          seasons.push({ n: s.season_number, count: s.episode_count || 0 });
        }
      }
    }
    return {
      title: title,
      year: (j.release_date || j.first_air_date || "").slice(0, 4),
      altTitles: alts,
      seasons: seasons
    };
  });
}

/** Absolute episode number from TMDB season structure (specials ignored). */
function absoluteEpisode(meta, season, episode) {
  var abs = episode, found = false;
  for (var i = 0; i < meta.seasons.length; i++) {
    var s = meta.seasons[i];
    if (s.n === season) { found = true; break; }
    if (s.n > 0 && s.n < season) abs += s.count;
  }
  return found ? abs : episode;
}

/** Score one candidate title against the query titles. */
function scoreCandidate(candTitle, queries, mediaType, season) {
  var ct = normalizeTitle(candTitle);
  if (!ct) return 0;
  var best = 0;
  for (var i = 0; i < queries.length; i++) {
    var qt = normalizeTitle(queries[i]);
    if (!qt) continue;
    var s = 0;
    if (ct === qt) s = 100;
    else if (ct.indexOf(qt) === 0) s = 82;
    else {
      var qToks = qt.split(" "), cToks = ct.split(" ");
      var allIn = true;
      for (var a = 0; a < qToks.length; a++) if (cToks.indexOf(qToks[a]) === -1) { allIn = false; break; }
      if (allIn) s = 78;
      else {
        var hit = 0;
        for (var b = 0; b < cToks.length; b++) if (qToks.indexOf(cToks[b]) !== -1) hit++;
        s = Math.round(55 * hit / Math.max(cToks.length, 1));
      }
    }
    if (s > best) best = s;
  }
  if (mediaType === "tv" && /\bmovie\b/.test(ct)) best -= 45;
  if (mediaType === "movie" && /\bseason\b/.test(ct)) best -= 25;
  if (season > 1 && new RegExp("\\bseason " + season + "\\b").test(ct)) best += 35;
  return best;
}

/** Site search (WP REST) -> best series post { title, url, score } or null. */
function findSeries(meta, mediaType, season) {
  var queries = [meta.title];
  if (season > 1) queries.push(meta.title + " Season " + season);
  for (var i = 0; i < meta.altTitles.length && queries.length < 4; i++) queries.push(meta.altTitles[i]);
  var best = null;
  var chain = Promise.resolve();
  queries.forEach(function (q) {
    chain = chain.then(function () {
      if (best && best.score >= 82) return null;
      var url = SITE + "/wp-json/wp/v2/search?search=" + encodeURIComponent(q) + "&per_page=50";
      return fetchJson(url, { "User-Agent": UA }).then(function (arr) {
        if (!Array.isArray(arr)) return;
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          if (!it || !it.url || it.url.indexOf("/anime/") === -1) continue;
          var title = decodeHtml(it.title || "");
          var sc = scoreCandidate(title, queries, mediaType, season);
          if (!best || sc > best.score) best = { title: title, url: it.url, score: sc };
        }
      });
    });
  });
  return chain.then(function () {
    if (best && best.score >= 55) return best;
    return null;
  });
}

/** All root-level post links of this host in a page. */
function rootPostLinks(html) {
  var out = [], seen = {};
  var re = /href="(https:\/\/donghuastream\.org\/[a-z0-9][a-z0-9\-]*\/)"/gi, m;
  while ((m = re.exec(html)) !== null) {
    if (!seen[m[1]]) { seen[m[1]] = true; out.push(m[1]); }
  }
  return out;
}

/** Parse one episode-post URL into { season, ep, abs } (fields may be null). */
function parseEpisodeSlug(url) {
  var season = null, ep = null, abs = null, m;
  if ((m = url.match(/-season-(\d+)-episode-(\d+)/))) { season = parseInt(m[1], 10); ep = parseInt(m[2], 10); }
  else if ((m = url.match(/-episode-(\d+)/))) { ep = parseInt(m[1], 10); }
  if ((m = url.match(/-ep-(\d+)(?:-|\/)/))) abs = parseInt(m[1], 10);
  else if (season !== null && (m = url.match(/-episode-\d+-(\d+)(?:-|\/)/))) abs = parseInt(m[1], 10);
  if (ep === null) return null;
  return { url: url, season: season, ep: ep, abs: abs };
}

/** Pick the watch page for the requested episode (or a movie) from a series page. */
function pickWatchPage(html, meta, mediaType, season, episode) {
  var links = rootPostLinks(html);
  if (mediaType === "movie") {
    var seriesSlug = null;
    var sm = meta.seriesUrl.match(/\/anime\/([a-z0-9\-]+)\//);
    if (sm) seriesSlug = sm[1];
    var parts = [], singles = [];
    for (var i = 0; i < links.length; i++) {
      var u = links[i];
      if (u.indexOf("/anime/") !== -1) continue;
      if (seriesSlug && u.indexOf("/" + seriesSlug) === -1 && u.replace(SITE + "/", "").indexOf(seriesSlug) !== 0) continue;
      if (/-episode-\d+/.test(u)) { singles.push(u); continue; }
      if (/-part-\d+/.test(u)) parts.push(u);
      else singles.push(u);
    }
    parts.sort();
    if (parts.length) return parts[0];
    if (singles.length === 1) return singles[0];
    return null;
  }
  var abs = absoluteEpisode(meta, season, episode);
  var entries = [];
  for (var j = 0; j < links.length; j++) {
    var e = parseEpisodeSlug(links[j]);
    if (e) entries.push(e);
  }
  var i2;
  for (i2 = 0; i2 < entries.length; i2++) if (entries[i2].abs !== null && entries[i2].abs === abs) return entries[i2].url;
  for (i2 = 0; i2 < entries.length; i2++) if (entries[i2].season === season && entries[i2].ep === episode) return entries[i2].url;
  for (i2 = 0; i2 < entries.length; i2++) if (entries[i2].season === null && entries[i2].abs === null && entries[i2].ep === abs) return entries[i2].url;
  if (meta.seasonPost) {
    for (i2 = 0; i2 < entries.length; i2++) if (entries[i2].season === null && entries[i2].ep === episode) return entries[i2].url;
  }
  return null;
}

/** Extract the server list of an episode page: [{ label, src }]. */
function extractServers(html) {
  var out = [], seen = {};
  function push(label, src) {
    if (!src) return;
    if (src.indexOf("//") === 0) src = "https:" + src;
    if (src.indexOf("http") !== 0 || seen[src]) return;
    seen[src] = true;
    out.push({ label: label || "", src: src });
  }
  var sel = html.match(/<select class="mirror"[\s\S]*?<\/select>/i);
  if (sel) {
    var optRe = /<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi, m;
    while ((m = optRe.exec(sel[0])) !== null) {
      var val = m[1], label = decodeHtml(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
      if (!val) continue;
      var decoded = null;
      try { decoded = atob(val.replace(/\s+/g, "")); } catch (e) { decoded = null; }
      var srcM = decoded && decoded.match(/src="([^"]+)"/);
      if (srcM) push(label, srcM[1]);
      else if (val.indexOf("http") === 0) push(label, val);
    }
  }
  if (!out.length) {
    var holder = html.match(/id="embed_holder"[\s\S]{0,4000}/i);
    if (holder) {
      var dm = holder[0].match(/data-litespeed-src="([^"]+)"/) || holder[0].match(/<iframe[^>]+src="(?!about:blank)([^"]+)"/i);
      if (dm) push("", dm[1]);
    }
  }
  return out;
}

function hostOf(url) {
  var m = String(url || "").match(/^https?:\/\/([a-z0-9.\-]+)/i);
  return m ? m[1].toLowerCase() : "";
}

/** Dailymotion embed -> signed HLS url + the video's own max format. */
function resolveDailymotion(embedUrl) {
  var idM = embedUrl.match(/[?&]video=([A-Za-z0-9]+)/) || embedUrl.match(/\/video\/([A-Za-z0-9]+)/);
  if (!idM) return Promise.resolve(null);
  var url = "https://www.dailymotion.com/player/metadata/video/" + idM[1];
  return fetchJson(url, { "User-Agent": UA, "Referer": "https://geo.dailymotion.com/" }).then(function (j) {
    if (!j || !j.qualities || !j.qualities.auto || !j.qualities.auto[0]) return null;
    var m3u8 = j.qualities.auto[0].url;
    if (!m3u8 || m3u8.indexOf("http") !== 0) return null;
    var q = null, best = 0;
    // Claim only the top of the actually-served ladder: the numeric
    // keys of `qualities`. (stream_formats can list AI-upscale
    // formats that are never served in the HLS ladder.)
    for (var k in j.qualities) {
      var n = parseInt(k, 10);
      if (!isNaN(n) && n > best) { best = n; q = n + "p"; }
    }
    return { url: m3u8, quality: q };
  });
}

/** OK.ru embed -> [{ url, quality }] from its data-options metadata. */
function resolveOkRu(embedUrl) {
  return fetchText(embedUrl, { "User-Agent": UA, "Referer": SITE + "/" }).then(function (html) {
    if (!html) return [];
    var m = html.match(/data-options="([^"]+)"/);
    if (!m) return [];
    var opts = null;
    try { opts = JSON.parse(decodeHtml(m[1])); } catch (e) { return []; }
    var md = opts && opts.flashvars && opts.flashvars.metadata;
    if (typeof md === "string") { try { md = JSON.parse(md); } catch (e) { return []; } }
    if (!md || !Array.isArray(md.videos)) return [];
    var out = [];
    for (var i = 0; i < md.videos.length; i++) {
      var v = md.videos[i];
      if (!v || !v.url) continue;
      out.push({ url: v.url, quality: OK_TIERS[v.name] || null });
    }
    return out;
  });
}

async function getStreams(tmdbId, mediaType, season, episode) {
  var id = parseInt(tmdbId, 10);
  if (!id || (mediaType !== "movie" && mediaType !== "tv")) return [];
  if (mediaType === "tv" && (season == null || episode == null)) return [];
  try {
    console.log(TAG + " Fetching " + mediaType + " " + id +
      (mediaType === "tv" ? " S" + season + "E" + episode : ""));
    var meta = await tmdbMeta(id, mediaType);
    if (!meta) {
      console.error(TAG + " TMDB lookup failed for " + id);
      return [];
    }
    var series = await findSeries(meta, mediaType, season);
    if (!series) {
      console.error(TAG + " no series match for \"" + meta.title + "\"");
      return [];
    }
    meta.seriesUrl = series.url;
    meta.seasonPost = season > 1 && new RegExp("\\bseason " + season + "\\b").test(normalizeTitle(series.title));
    var seriesHtml = await fetchText(series.url, { "User-Agent": UA });
    if (!seriesHtml) {
      console.error(TAG + " series page failed: " + series.url);
      return [];
    }
    var watchUrl = pickWatchPage(seriesHtml, meta, mediaType, season, episode);
    if (!watchUrl) {
      console.error(TAG + " no watch page for " + meta.title +
        (mediaType === "tv" ? " S" + season + "E" + episode : " (movie)"));
      return [];
    }
    var epHtml = watchUrl === series.url ? seriesHtml : await fetchText(watchUrl, { "User-Agent": UA });
    if (!epHtml) {
      console.error(TAG + " episode page failed: " + watchUrl);
      return [];
    }
    var servers = extractServers(epHtml);
    if (!servers.length) {
      console.error(TAG + " no servers on " + watchUrl);
      return [];
    }
    var rowName = (meta.title + " " + (meta.year || "") + " DonghuaStream").replace(/\s+/g, " ").trim();
    var out = [], seen = {};
    function addRow(url, title, quality, headers) {
      if (!url || url.indexOf("http") !== 0 || seen[url]) return;
      seen[url] = true;
      var row = { url: url, name: rowName, title: title, language: "Chinese", headers: headers };
      if (quality) row.quality = quality;
      out.push(row);
    }
    for (var i = 0; i < servers.length; i++) {
      var sv = servers[i], host = hostOf(sv.src);
      if (host.indexOf("dailymotion.com") !== -1) {
        var dm = await resolveDailymotion(sv.src);
        if (dm) {
          addRow(dm.url,
            "\uD83C\uDF10 Chinese \u00B7 Multi Sub" + (dm.quality ? "  |  \uD83D\uDCFA " + dm.quality : "") + "  |  \uD83C\uDF9E\uFE0F M3U8",
            dm.quality, { "User-Agent": UA });
        } else console.error(TAG + " dailymotion gave no stream on " + watchUrl);
      } else if (host.indexOf("ok.ru") !== -1) {
        var oks = await resolveOkRu(sv.src);
        if (oks.length) {
          for (var k = 0; k < oks.length; k++) {
            addRow(oks[k].url,
              "\uD83C\uDF10 Chinese \u00B7 ENG Sub" + (oks[k].quality ? "  |  \uD83D\uDCFA " + oks[k].quality : "") + "  |  \uD83C\uDF9E\uFE0F MP4",
              oks[k].quality, { "User-Agent": UA, "Referer": "https://ok.ru/" });
          }
        } else console.error(TAG + " ok.ru gave no stream on " + watchUrl);
      }
      // rumble.com (bot-check) and streamplay (packed script) are not
      // resolved by this plug; they simply produce no rows.
    }
    console.log(TAG + " " + meta.title + " -> " + out.length + " streams");
    return out;
  } catch (e) {
    console.error(TAG + " " + (e && e.message ? e.message : e));
    return [];
  }
}

if (typeof module !== "undefined" && module.exports) { module.exports = { getStreams }; }
globalThis.getStreams = getStreams;
