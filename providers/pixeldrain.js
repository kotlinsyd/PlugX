// PlavioPlug — PixelDrain (standalone on-device scraper)
// Links the dead `pixeldrain` entry to a site that actually carries
// PixelDrain links: HDHub4u. The old JSON config pointed at the
// MoviesBazar chain, whose watch pages contain ZERO pixeldrain links.
// Chain (server-free, no Plavio server calls):
//   TMDB lookup (public community key) -> title + year + imdb id
//   GET https://search.pingora.fyi/collections/post/documents/search
//       (the site's own search API; needs Referer + Origin or
//       Cloudflare 403s) -> post permalink + imdb id
//   GET post page -> hubdrive.blog/file/<id> links
//   GET hubdrive page -> button -> hubcloud.mov/drive/<id>
//   GET hubcloud page -> var url -> gamerxyt.com/hubcloud.php
//   GET gamerxyt page -> var pxl = "https://pixeldrain.dev/u/<id>"
//       (the anchor href is a DECOY that 404s; the JS var holds the
//       real id — proven on Brawlers 2026)
//   GET https://pixeldrain.com/api/file/<id>/info (name + size +
//       existence: dead ids answer success:false) + Range probe of
//       https://pixeldrain.dev/api/file/<id>?download (must answer
//       200/206) -> return only serving rows.
// Coverage (measured 2026-11-22): only posts that carry hubdrive links
// whose HubCloud files have a PixelDrain mirror — about half of recent
// movie posts sampled (Brawlers, Drones, Perfect Liars yes; The Holdovers
// and The Raid have no hubdrive links at all). Titles with no such link
// honestly return []. Movie only: series posts carry only season-pack
// hubdrive links, and the one pack tested (Breaking Bad S1) had no
// PixelDrain mirror, so TV is not claimed.
// Playback headers: User-Agent only (PixelDrain serves with no special
// headers — 206 + EBML verified).

var TMDB_KEY = "439c478a771f35c05022f9feabcca01c"; // public community key, also used by the 4KHDHub/MalluMV plugs
var SEARCH_API = "https://search.pingora.fyi/collections/post/documents/search";
var SITE = "https://new15.hdhub4u.cl";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var FETCH_HEADERS = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
var SEARCH_HEADERS = { "User-Agent": UA, "Accept": "application/json", "Referer": SITE + "/search.html", "Origin": SITE };
var PLAYBACK_HEADERS = { "User-Agent": UA };

function withTimeout(ms) {
  try {
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  } catch (e) {}
  return undefined;
}

function fetchText(url, headers, timeoutMs) {
  var o = { headers: headers || FETCH_HEADERS, redirect: "follow" };
  var sig = withTimeout(timeoutMs || 20000);
  if (sig) o.signal = sig;
  return fetch(url, o).then(function (r) {
    if (!r.ok) return null;
    return r.text().catch(function () { return null; });
  }).catch(function () { return null; });
}

function fetchJson(url, headers, timeoutMs) {
  return fetchText(url, headers, timeoutMs).then(function (t) {
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  });
}

// Returns true if a Range probe of the URL answers 2xx (serving).
function probeOk(url) {
  var o = { headers: { "User-Agent": UA, "Range": "bytes=0-1023" }, redirect: "follow" };
  var sig = withTimeout(15000);
  if (sig) o.signal = sig;
  return fetch(url, o).then(function (r) { return !!r && r.ok; }).catch(function () { return false; });
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

function qualityOf(text) {
  var m = String(text || "").match(/(2160|1080|720|480)\s*p/i);
  if (!m) return 0;
  return parseInt(m[1], 10);
}

function qualityLabel(q) {
  return q >= 2160 ? "2160p" : q > 0 ? q + "p" : "Unknown";
}

// House row format helpers (display-only): human size for the title
// line, clean file name for the ℹ️ part (strip extension, dots /
// underscores / brackets become spaces).
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

// One hubdrive link -> its pixeldrain ids (via hubcloud + gamerxyt).
function resolveHubdrive(hubUrl, referer) {
  return fetchText(hubUrl, { "User-Agent": UA, "Referer": referer }, 20000).then(function (html) {
    if (!html) return [];
    var hcUrl = null;
    var tagRe = /<a\b[^>]*>/g, m;
    while ((m = tagRe.exec(html)) !== null) {
      if (m[0].indexOf("btn-success1") === -1) continue;
      var hm = m[0].match(/href="(https:\/\/hubcloud[^"]+)"/);
      if (hm) { hcUrl = hm[1]; break; }
    }
    if (!hcUrl) return [];
    return fetchText(hcUrl, { "User-Agent": UA, "Referer": hubUrl }, 20000).then(function (hcHtml) {
      if (!hcHtml) return [];
      var vm = hcHtml.match(/var url = '([^']+)'/);
      if (!vm) return [];
      return fetchText(vm[1], { "User-Agent": UA, "Referer": hcUrl }, 20000).then(function (gxHtml) {
        if (!gxHtml) return [];
        var seen = {}, ids = [];
        var re = /var pxl\s*=\s*"https:\/\/pixeldrain\.dev\/u\/([A-Za-z0-9]+)"/g, m2;
        while ((m2 = re.exec(gxHtml)) !== null) {
          if (!seen[m2[1]]) { seen[m2[1]] = true; ids.push(m2[1]); }
        }
        var re2 = /pixeldrain\.dev\/u\/([A-Za-z0-9]+)/g;
        while ((m2 = re2.exec(gxHtml)) !== null) {
          if (!seen[m2[1]]) { seen[m2[1]] = true; ids.push(m2[1]); }
        }
        return ids;
      });
    });
  }).catch(function () { return []; });
}

function getStreams(tmdbId, mediaType, season, episode) {
  if (mediaType !== "movie") return Promise.resolve([]);
  if (!/^\d+$/.test(String(tmdbId || ""))) return Promise.resolve([]);

  return fetchJson("https://api.themoviedb.org/3/movie/" + tmdbId + "?api_key=" + TMDB_KEY + "&language=en-US")
    .then(function (meta) {
      if (!meta || !meta.title) return [];
      var title = meta.title;
      var year = (meta.release_date || "").slice(0, 4);
      var imdb = meta.imdb_id || "";
      console.log("[PixelDrain] " + title + " (" + year + ")");
      var q = SEARCH_API + "?q=" + encodeURIComponent(title) +
        "&query_by=post_title,category,stars,director,imdb_id" +
        "&query_by_weights=4,2,2,2,4&sort_by=sort_by_date:desc&limit=15&highlight_fields=none";
      return fetchJson(q, SEARCH_HEADERS, 20000).then(function (res) {
        if (!res || !res.hits || !res.hits.length) return [];
        var best = null, bestScore = 0;
        res.hits.forEach(function (h) {
          var doc = (h && h.document) || {};
          if (!doc.permalink || !doc.post_title) return;
          if (imdb && doc.imdb_id && doc.imdb_id === imdb) { best = doc; bestScore = 1; return; }
          var s = titleScore(title, doc.post_title);
          if (year && doc.post_title.indexOf(year) === -1) s -= 0.3;
          if (s > bestScore) { bestScore = s; best = doc; }
        });
        if (!best || bestScore < 0.7) {
          console.log("[PixelDrain] no title match (best " + bestScore.toFixed(2) + ")");
          return [];
        }
        var postUrl = best.permalink;
        return fetchText(postUrl, null, 20000).then(function (html) {
          if (!html) {
            // Search-index permalinks sometimes point at a dead mirror;
            // retry the same slug on the known-good domain.
            var slug = postUrl.replace(/^https?:\/\/[^/]+/, "");
            if (slug && slug !== "/") return fetchText(SITE + slug, null, 20000);
            return null;
          }
          return html;
        }).then(function (html) {
          if (!html) return [];
          var seen = {}, links = [];
          var re = /<a\b[^>]*href="(https:\/\/hubdrive\.blog\/file\/\d+)"[^>]*>([\s\S]*?)<\/a>/g, m;
          while ((m = re.exec(html)) !== null) {
            if (seen[m[1]]) continue;
            seen[m[1]] = true;
            var label = (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            links.push({ url: m[1], label: label });
          }
          if (!links.length) {
            console.log("[PixelDrain] no hubdrive links on post");
            return [];
          }
          var picked = links.slice(0, 4);
          return Promise.all(picked.map(function (l) {
            return resolveHubdrive(l.url, postUrl).then(function (ids) {
              return { label: l.label, ids: ids };
            });
          })).then(function (groups) {
            var seenId = {}, ids = [], labelById = {};
            groups.forEach(function (g) {
              (g.ids || []).forEach(function (id) {
                if (!seenId[id]) { seenId[id] = true; ids.push(id); labelById[id] = g.label; }
              });
            });
            if (!ids.length) return [];
            var use = ids.slice(0, 6);
            return Promise.all(use.map(function (id) {
              var dl = "https://pixeldrain.dev/api/file/" + id + "?download";
              return Promise.all([
                fetchJson("https://pixeldrain.com/api/file/" + id + "/info", { "User-Agent": UA }, 15000),
                probeOk(dl)
              ]).then(function (pair) {
                var info = pair[0], serves = pair[1];
                if (!serves) return null;
                if (!info || info.success !== true) return null;
                var name = info.name || "";
                var q = qualityOf(name) || qualityOf(labelById[id]);
                // House row format (display-only): name carries title,
                // year, plug and quality; title carries quality, size
                // (PixelDrain API bytes), extension and clean file
                // name — each only when really known. "Unknown"
                // quality and 0/missing size are left out, never shown.
                // No per-row language is known.
                var ql = q ? qualityLabel(q) : "";
                var extM = name.match(/\.([A-Za-z0-9]+)$/);
                var ext = extM ? extM[1].toUpperCase() : "";
                var bytes = (typeof info.size === "number" && info.size > 0) ? info.size : 0;
                var parts = [];
                if (ql) parts.push("📺 " + ql);
                if (bytes > 0) parts.push("💾 " + humanSize(bytes));
                if (ext) parts.push("🎞️ " + ext);
                if (name) parts.push("ℹ️ " + cleanName(name));
                var row = {
                  name: (title + " " + (year || "") + " PixelDrain" + (ql ? " " + ql : "")).replace(/\s+/g, " ").trim(),
                  url: dl,
                  headers: PLAYBACK_HEADERS
                };
                if (parts.length) row.title = parts.join("  |  ");
                if (ql) row.quality = ql;
                if (bytes > 0) row.size = bytes;
                return row;
              });
            })).then(function (rows) {
              var seenUrl = {}, out = [];
              rows.forEach(function (r) {
                if (!r || !/^https:\/\//i.test(r.url)) return;
                if (seenUrl[r.url]) return;
                seenUrl[r.url] = true;
                out.push(r);
              });
              return out;
            });
          });
        });
      });
    })
    .catch(function (err) {
      console.log("[PixelDrain] Error: " + (err && err.message));
      return [];
    });
}

if (typeof module !== "undefined" && module.exports) { module.exports = { getStreams }; }
globalThis.getStreams = getStreams;
