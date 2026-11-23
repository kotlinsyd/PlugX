// PlavioPlug — MoviesBazar (standalone on-device scraper) — PlugX v1.0.4: house row format, batch D
// Replaces the dead JSON rule config (providers/moviesbazar.json v1.0.2).
// Why the JSON config died: the site's watch page lists several "servers"
// per title, but most of them are dead — the asrmo449ddj.com play host is
// offline ("We are offline now"), its signed stream2 index.m3u8 links all
// 404, and the mbstream p2p resolver answers "not found". The ONLY live
// source on the site is BunnyCDN (vz-*.b-cdn.net/.../playlist.m3u8), which
// serves only with a moviesbazar Referer (403 without it). A JSON regex
// cannot tell a live link from a dead one, so this JS plug probes every
// candidate and returns only links that byte-verify as HLS.
// Chain (server-free, no Plavio server calls):
//   TMDB lookup (public community key) -> title + year
//   POST https://server.moviesbazar.media/api/v1/movies/search?q=<title>
//       -> { moviesData: [{ imdbId, title, releaseYear, ... }] }
//   GET https://www.moviesbazar.media/watch/movie/x/<numeric imdb id>
//       -> Next.js page; movieDetails.watchLink[] holds
//          { source, label, labelTag } per server
//   Probe each .m3u8/.mp4 source (Range + Referer) in parallel, keep
//   only serving ones, deduped.
// Coverage (measured 2026-11-22): ~half the catalogue has a live BunnyCDN
// link (7 of 15 recent homepage titles; Inception + Sinners verified).
// Titles with no live link (e.g. The Holdovers, whose only server is the
// dead play host and which has no download links at all) honestly return
// []. Movie only — the site's series pages use a different watch pattern
// and the live manifest claims movie only.
// Playback headers: Referer https://www.moviesbazar.media/ is REQUIRED
// (BunnyCDN answers 403 without it). Declared on every row.

var TMDB_KEY = "439c478a771f35c05022f9feabcca01c"; // public community key, also used by the 4KHDHub/MalluMV plugs
var SEARCH_API = "https://server.moviesbazar.media/api/v1/movies/search";
var SITE = "https://www.moviesbazar.media";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
var FETCH_HEADERS = { "User-Agent": UA, "Referer": SITE + "/" };
var PLAYBACK_HEADERS = { "User-Agent": UA, "Referer": SITE + "/" };

function withTimeout(ms) {
  try {
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  } catch (e) {}
  return undefined;
}

function fetchText(url, opts) {
  var o = opts || {};
  o.headers = o.headers || FETCH_HEADERS;
  o.redirect = "follow";
  var sig = withTimeout(o.timeoutMs || 20000);
  if (sig) o.signal = sig;
  delete o.timeoutMs;
  return fetch(url, o).then(function (r) {
    if (!r.ok) return null;
    return r.text().catch(function () { return null; });
  }).catch(function () { return null; });
}

function fetchJson(url, opts) {
  return fetchText(url, opts).then(function (t) {
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  });
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Coverage-based title match: fraction of the query title's words found in
// the candidate title. Same guard shape as the other plugs (>= 0.7).
function titleScore(query, candidate) {
  var q = norm(query).split(/\s+/).filter(Boolean);
  var c = norm(candidate);
  if (!q.length || !c) return 0;
  var hit = 0;
  q.forEach(function (w) { if (c.indexOf(w) !== -1) hit++; });
  return hit / q.length;
}

/** Language named in the server label ("Server 1 Hindi (No Ads)") — the only
    language info this plug has. Empty when the label names none. */
function langOfLabel(label) {
  var m = String(label || "").match(/\b(Hindi|English|Tamil|Telugu|Malayalam|Kannada|Bengali|Punjabi|Marathi|Urdu|French|Spanish|Portuguese)\b/i);
  if (!m) return "";
  return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
}

function getStreams(tmdbId, mediaType, season, episode) {
  if (mediaType !== "movie") return Promise.resolve([]);
  if (!/^\d+$/.test(String(tmdbId || ""))) return Promise.resolve([]);

  return fetchJson("https://api.themoviedb.org/3/movie/" + tmdbId + "?api_key=" + TMDB_KEY + "&language=en-US")
    .then(function (meta) {
      if (!meta || !meta.title) return [];
      var title = meta.title;
      var year = (meta.release_date || "").slice(0, 4);
      console.log("[MoviesBazar] " + title + " (" + year + ")");
      return fetchJson(SEARCH_API + "?q=" + encodeURIComponent(title), { method: "POST" })
        .then(function (res) {
          if (!res || !res.moviesData || !res.moviesData.length) return [];
          var best = null, bestScore = 0;
          res.moviesData.forEach(function (m) {
            if (!m || !m.imdbId || m.type !== "movie") return;
            var s = titleScore(title, m.title);
            if (year && m.releaseYear && String(m.releaseYear) !== year) s -= 0.3;
            if (s > bestScore) { bestScore = s; best = m; }
          });
          if (!best || bestScore < 0.7) {
            console.log("[MoviesBazar] no title match (best " + bestScore.toFixed(2) + ")");
            return [];
          }
          var numeric = String(best.imdbId).replace(/^tt/, "");
          var watchUrl = SITE + "/watch/movie/x/" + numeric;
          return fetchText(watchUrl).then(function (html) {
            if (!html) return [];
            var un = html.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
            var wl = un.match(/"watchLink":\[(.*?)\]/);
            if (!wl) return [];
            var seen = {}, cands = [];
            var re = /\{"source":"([^"]+)","label":"([^"]*)","labelTag":(?:"([^"]*)"|null)\}/g, m2;
            while ((m2 = re.exec(wl[1])) !== null) {
              var src = m2[1];
              if (!/^https:\/\//i.test(src)) continue;
              if (!/\.m3u8(\?|#|$)/i.test(src) && !/\.mp4(\?|#|$)/i.test(src)) continue;
              if (seen[src]) continue;
              seen[src] = true;
              cands.push({ url: src, label: m2[2] || "", tag: m2[3] || "" });
            }
            if (!cands.length) return [];
            // Probe every candidate in parallel; keep only serving links.
            // BunnyCDN needs the Referer — without it the probe 403s.
            return Promise.all(cands.map(function (c) {
              return fetchText(c.url, {
                headers: { "User-Agent": UA, "Referer": SITE + "/", "Range": "bytes=0-1023" },
                timeoutMs: 15000
              }).then(function (head) {
                if (!head) return null;
                var isHls = head.indexOf("#EXTM3U") === 0;
                var isMp4 = head.indexOf("ftyp") === 4;
                if (!isHls && !isMp4) return null;
                // House row format (display-only). No size is known (BunnyCDN
                // playlist carries none) and quality is never known — the old
                // "Unknown" quality is dropped, not shown. Language comes from
                // the server label; ext from the stream URL (.m3u8/.mp4); the
                // server label itself is the ℹ️ info (no filename exists).
                var label = [c.label, c.tag].filter(Boolean).join(" ");
                var lang = langOfLabel(label);
                var ext = /\.mp4(\?|#|$)/i.test(c.url) ? "MP4" : "M3U8";
                var parts = [];
                if (lang) parts.push("\uD83C\uDF10 " + lang);
                parts.push("\uD83C\uDF9E\uFE0F " + ext);
                if (label) parts.push("\u2139\uFE0F " + label);
                var row = {
                  name: (title + " " + (year || "") + " MoviesBazar").replace(/\s+/g, " ").trim(),
                  title: parts.join("  |  "),
                  url: c.url,
                  headers: PLAYBACK_HEADERS
                };
                if (lang) row.language = lang;
                return row;
              });
            })).then(function (rows) {
              return rows.filter(Boolean);
            });
          });
        });
    })
    .catch(function (err) {
      console.log("[MoviesBazar] Error: " + (err && err.message));
      return [];
    });
}

if (typeof module !== "undefined" && module.exports) { module.exports = { getStreams }; }
globalThis.getStreams = getStreams;
