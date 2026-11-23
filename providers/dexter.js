// PlavioPlug — Dexter (standalone on-device scraper)
// Port of the PlavioHD Dexter lane (dexter.pw). TMDB-keyed, plain
// fetches only — no signing, no JS execution, no Plavio server:
//   GET https://dexter.pw/api/s/{serverId}/movie/{tmdbId}?v=3
//   GET https://dexter.pw/api/s/{serverId}/tv/{tmdbId}/{s}/{e}?v=3
// for server ids [21, 1, 2, 3, 4, 5]. All six requests fire up
// front, then the FIRST server (in that order) whose answer is
// an HLS master playlist wins. Variants are read from the
// master's RESOLUTION tags and resolved against the playlist's
// effective origin (the recipe's own resolve rule).
// Quality rule (the source's own hard floor): width >= 3840 or
// height >= 2160 -> 2160p, width >= 1920 or height >= 1080 ->
// 1080p, anything below is dropped — nothing sub-1080 is served.
// Playback headers: desktop UA + dexter.pw Referer/Origin on
// every row. HTTPS only, deduped, best first.
// Note: dexter.pw has historically answered a Cloudflare
// challenge from datacenter egress IPs; that is an IP fence at
// the source, not a server dependency — on a user's own device
// connection the plain fetch is the whole chain.

var BASE = "https://dexter.pw";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
var SERVER_IDS = [21, 1, 2, 3, 4, 5];
var FETCH_HEADERS = {
  "User-Agent": UA,
  "Referer": BASE + "/",
  "Origin": BASE
};
var PLAYBACK_HEADERS = {
  "User-Agent": UA,
  "Referer": BASE + "/",
  "Origin": BASE
};


/* House row format (display only — same streams, URLs, order, counts). */
function houseName(title, year, plug, quality) {
  var parts = [];
  if (title) parts.push(title);
  if (year) parts.push(year);
  parts.push(plug);
  if (quality) parts.push(quality);
  return parts.join(' ');
}
function houseTitle(parts) {
  return parts.filter(function (p) { return !!p; }).join('  |  ');
}
function normQuality(q) {
  if (q == null) return null;
  var s = String(q).trim();
  if (!s) return null;
  if (/^4k$/i.test(s)) return '2160p';
  if (/^\d{3,4}p$/i.test(s)) return s;
  if (/^\d{3,4}$/.test(s)) return s + 'p';
  return null;
}
function extOf(url, fallback) {
  var u = String(url || '').split('?')[0];
  var m = u.match(/\.([A-Za-z0-9]+)$/);
  var e = m ? m[1] : (fallback || '');
  return e ? e.toUpperCase() : null;
}
function cleanName(name) {
  return String(name || '').replace(/\.(mkv|mp4|avi|webm|m3u8)$/i, '').replace(/[\[\]()._-]/g, ' ').replace(/\s+/g, ' ').trim();
}
function parseSize(str) {
  if (typeof str !== 'string') return null;
  var m = str.match(/([\d.]+)\s*([KMGT]B)/i);
  if (!m) return null;
  var n = parseFloat(m[1]);
  var u = m[2].toUpperCase();
  var mult = u === 'KB' ? 1024 : u === 'MB' ? 1024 * 1024 : u === 'GB' ? 1024 * 1024 * 1024 : 1024 * 1024 * 1024 * 1024;
  return Math.round(n * mult);
}
function fetchPlaylist(url) {
  return fetch(url, { redirect: "follow", headers: FETCH_HEADERS })
    .then(function (r) {
      if (!r.ok) return null;
      return r.text().then(function (text) {
        return { text: text, effectiveUrl: r.url || url };
      });
    })
    .catch(function () { return null; });
}

/** The recipe's quality rule: 2160p / 1080p by RESOLUTION, or not served. */
function toQuality(width, height) {
  if (width >= 3840 || height >= 2160) return 2160;
  if (width >= 1920 || height >= 1080) return 1080;
  return 0;
}

/** The recipe's URL rule: absolute URLs pass through; relative
 * ones resolve against the playlist's origin. */
function resolveUrl(path, baseUrl) {
  try {
    if (path.indexOf("http://") === 0 || path.indexOf("https://") === 0) return path;
    var base = new URL(baseUrl && baseUrl.indexOf("http") === 0 ? baseUrl : BASE);
    return new URL(path, base.origin).href;
  } catch (e) {
    return null;
  }
}

function parseMasterPlaylist(text, baseUrl) {
  var lines = String(text || "").split("\n")
    .map(function (l) { return l.replace(/^\s+|\s+$/g, ""); })
    .filter(Boolean);
  var streams = [];
  for (var i = 0; i < lines.length - 1; i++) {
    var info = lines[i];
    if (info.indexOf("#EXT-X-STREAM-INF") !== 0) continue;
    var next = lines[i + 1];
    if (next.charAt(0) === "#") continue;
    var res = info.match(/RESOLUTION=(\d+)x(\d+)/);
    if (!res) continue;
    var quality = toQuality(parseInt(res[1], 10), parseInt(res[2], 10));
    if (!quality) continue;
    var absolute = resolveUrl(next, baseUrl);
    if (!absolute) continue;
    streams.push({ url: absolute, quality: quality });
  }
  return streams;
}

function fetchFromServer(serverId, tmdbId, apiType, season, episode) {
  var url = BASE + "/api/s/" + serverId + "/" + apiType + "/" + tmdbId;
  if (apiType === "tv") url += "/" + season + "/" + episode;
  url += "?v=3";
  return fetchPlaylist(url).then(function (got) {
    if (!got || !got.text || got.text.indexOf("#EXTM3U") < 0) return [];
    var effectiveBase = got.effectiveUrl && got.effectiveUrl.indexOf("http") === 0 ? got.effectiveUrl : url;
    return parseMasterPlaylist(got.text, effectiveBase);
  });
}

function qualityLabel(q) {
  return q >= 2160 ? "4K" : q + "p";
}

function getStreams(tmdbId, mediaType, season, episode) {
  if (!/^\d+$/.test(String(tmdbId || ""))) return Promise.resolve([]);
  var apiType = mediaType === "tv" ? "tv" : "movie";
  if (apiType === "tv" && (season == null || episode == null)) return Promise.resolve([]);

  console.log("[Dexter] Fetching " + apiType + " " + tmdbId +
    (apiType === "tv" ? " S" + season + "E" + episode : ""));

  // The recipe starts every server request, then reads them in
  // order and keeps the first non-empty answer.
  return Promise.all(SERVER_IDS.map(function (id) {
    return fetchFromServer(id, tmdbId, apiType, season, episode);
  })).then(function (results) {
    var found = [];
    for (var i = 0; i < results.length; i++) {
      if (results[i] && results[i].length > 0) { found = results[i]; break; }
    }
    var seen = {};
    var out = [];
    found.forEach(function (s) {
      if (!/^https:\/\//i.test(s.url)) return;
      if (seen[s.url]) return;
      seen[s.url] = true;
      var q = normQuality(qualityLabel(s.quality));
      var ext = extOf(s.url, "m3u8");
      out.push({
        name: "Dexter" + (q ? " " + q : ""),
        title: houseTitle([q ? "📺 " + q : null, ext ? "🎞️ " + ext : null]),
        url: s.url,
        quality: q,
        headers: PLAYBACK_HEADERS
      });
    });
    out.sort(function (a, b) {
      var qa = a.quality === "4K" ? 2160 : parseInt(a.quality, 10) || 0;
      var qb = b.quality === "4K" ? 2160 : parseInt(b.quality, 10) || 0;
      return qb - qa;
    });
    return out;
  }).catch(function (err) {
    console.error("[Dexter] Error:", err && err.message);
    return [];
  });
}

module.exports = { getStreams };
