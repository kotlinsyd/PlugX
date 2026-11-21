// PlavioPlug — MalluMV (standalone on-device scraper)
// Port of the PlavioHD MalluMV lane (mallumv.asia), server-free:
//   GET https://api.themoviedb.org/3/movie/<tmdbId>?api_key=<public key>
//       -> title + year (TMDB key below is the public community key
//          from the kit's 4khdhub.js example — Tapframe's public key)
//   GET https://mallumv.asia/search.php?q=<title>
//       -> movie page link  movie/<id>/<slug>.xhtml  (title+year matched)
//   GET movie page -> /internal/<n>/<id>/<file>.xhtml links (one per
//       quality: 480p / 720p / 1080p / 4K, label carries size)
//   GET each internal page -> PixelDrain link  https://pixeldrain.dev/u/<id>
//       -> direct file  https://pixeldrain.dev/api/file/<id>?download
// PixelDrain serves the raw file with no special headers (206 + EBML
// verified on Bandra 2023, 1080p MKV, 2.3 GB). Other hosts on the
// internal pages (HubCloud via gamerxyt — dead from this seat;
// GDFlix — Cloudflare challenge; DriveNext — 403) are skipped.
// Catalogue is Malayalam / Tamil / South Indian focused; English and
// Hindi titles are usually absent, so movie-only, no tv claim.

var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c"; // public key from the kit's 4khdhub.js example (Tapframe)
var TMDB_BASE = "https://api.themoviedb.org/3";
var BASE = "https://mallumv.asia";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var FETCH_HEADERS = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
var PLAYBACK_HEADERS = { "User-Agent": UA };

function fetchText(url) {
  return fetch(url, { redirect: "follow", headers: FETCH_HEADERS })
    .then(function (r) { if (!r.ok) return null; return r.text(); })
    .catch(function () { return null; });
}

function fetchJson(url) {
  return fetch(url, { redirect: "follow", headers: FETCH_HEADERS })
    .then(function (r) { if (!r.ok) return null; return r.json().catch(function () { return null; }); })
    .catch(function () { return null; });
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/^\s+|\s+$/g, "");
}

function qualityOf(label) {
  var l = String(label || "");
  if (/2160p|4k/i.test(l)) return 2160;
  var m = l.match(/(\d{3,4})p/i);
  if (m) return parseInt(m[1], 10);
  return 0;
}

function qualityLabel(q) {
  return q >= 2160 ? "4K" : q + "p";
}

function sizeBytes(label) {
  var m = String(label || "").match(/([\d.]+)\s*(GB|MB)/i);
  if (!m) return 0;
  var n = parseFloat(m[1]);
  return m[2].toUpperCase() === "GB" ? Math.round(n * 1024 * 1024 * 1024) : Math.round(n * 1024 * 1024);
}

function getStreams(tmdbId, mediaType, season, episode) {
  if (!/^\d+$/.test(String(tmdbId || ""))) return Promise.resolve([]);
  if (mediaType === "tv") return Promise.resolve([]);

  console.log("[MalluMV] Fetching movie " + tmdbId);

  return fetchJson(TMDB_BASE + "/movie/" + tmdbId + "?api_key=" + TMDB_API_KEY)
    .then(function (d) {
      if (!d || !d.title) return [];
      var title = d.title;
      var year = d.release_date ? parseInt(String(d.release_date).slice(0, 4), 10) : 0;
      var want = norm(title);
      return fetchText(BASE + "/search.php?q=" + encodeURIComponent(title)).then(function (html) {
        if (!html) return [];
        var $ = require("cheerio").load(html);
        var pageUrl = null;
        $("a[href*='movie/']").each(function (_i, el) {
          if (pageUrl) return;
          var href = $(el).attr("href") || "";
          var text = $(el).text() || "";
          if (!/(?:^|\/)movie\/\d+\//.test(href)) return;
          var m = text.match(/(.+?)\s*\((\d{4})\)/);
          if (!m) return;
          if (norm(m[1]) !== want) return;
          if (year && parseInt(m[2], 10) !== year) return;
          pageUrl = href.indexOf("http") === 0 ? href : BASE + (href.charAt(0) === "/" ? "" : "/") + href;
        });
        if (!pageUrl) { console.log("[MalluMV] No match for " + title + " (" + year + ")"); return []; }
        return fetchText(pageUrl).then(function (pageHtml) {
          if (!pageHtml) return [];
          var $$ = require("cheerio").load(pageHtml);
          var internals = [];
          $$("a[href*='/internal/']").each(function (_i, el) {
            var href = $$(el).attr("href") || "";
            var label = $$(el).text() || "";
            var q = qualityOf(label);
            if (!q) return;
            var abs = href.indexOf("http") === 0 ? href : BASE + (href.charAt(0) === "/" ? "" : "/") + href;
            internals.push({ url: abs, label: label.replace(/\s+/g, " ").trim(), quality: q });
          });
          if (!internals.length) return [];
          // Best first: 1080p, then 720p, then 4K, then the rest.
          var rank = function (q) { return q === 1080 ? 0 : q === 720 ? 1 : q === 2160 ? 2 : q === 480 ? 3 : 4; };
          internals.sort(function (a, b) { return rank(a.quality) - rank(b.quality); });
          var picked = internals.slice(0, 4);
          return Promise.all(picked.map(function (it) {
            return fetchText(it.url).then(function (inner) {
              if (!inner) return null;
              var $$$ = require("cheerio").load(inner);
              var pd = null;
              $$$("a[href*='pixeldrain.dev/u/']").each(function (_i, el) {
                if (pd) return;
                var href = $$$(el).attr("href") || "";
                var mm = href.match(/pixeldrain\.dev\/u\/([A-Za-z0-9]+)/);
                if (mm) pd = mm[1];
              });
              if (!pd) return null;
              return {
                name: "MalluMV",
                title: qualityLabel(it.quality) + " " + it.label + " • PixelDrain",
                url: "https://pixeldrain.dev/api/file/" + pd + "?download",
                quality: qualityLabel(it.quality),
                size: sizeBytes(it.label),
                headers: PLAYBACK_HEADERS
              };
            });
          })).then(function (rows) {
            var seen = {};
            var out = [];
            rows.forEach(function (r) {
              if (!r || !/^https:\/\//i.test(r.url)) return;
              if (seen[r.url]) return;
              seen[r.url] = true;
              out.push(r);
            });
            return out;
          });
        });
      });
    })
    .catch(function (err) {
      console.error("[MalluMV] Error:", err && err.message);
      return [];
    });
}

module.exports = { getStreams };
