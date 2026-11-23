// 111477 — wraps the official 111477 addon (st.111477.xyz) from the
// device. PlugX v1.0.3: house row format, batch D.
// device. The plug asks st. for streams itself, on the user's own
// connection, and returns the worker links st. mints. No Plavio
// server is involved at any point.
// Chain:
//   TMDB id -> IMDb id (TMDB API; public community key, the same
//   one the other PlugX plugs use)
//   GET https://st.111477.xyz/config/<cfg>/stream/movie/<imdb>.json
//   GET https://st.111477.xyz/config/<cfg>/stream/series/<imdb>:<s>:<e>.json
//   <cfg> = url-safe base64 (no padding) of the public no-key
//   config "https://a.111477.xyz/" — the bare base, exactly the
//   config a default st. install carries (an earlier build used
//   a "::sort=file-desc::limit=3" suffix borrowed from a watch
//   config; its rows hung on the owner's phone while the bare
//   config played, so the suffix is gone). st. returns streams
//   for it without any TMDB key, so none is embedded here.
// st. answers {"streams":[{"title":"<release name> [a11 <size>]",
// "url":"https://<fleet>.workers.dev/d/<32-hex>"}]}. Quality and
// size exist ONLY as that title text — rows pass the text through
// verbatim (the quality token and the "[a11 …]" size are parsed
// out of the same text, never upgraded). st. specifies no
// playback headers, so rows declare none.
// Known behaviour of the source: st. flags datacenter IPs by
// answering a single "Spammy IP" stub stream (filtered out below —
// it is never returned as a row), and its worker fleet runs a
// per-file concurrency lock that can answer 429 "id busy" while a
// file is hot. On a user's own connection this addon is the
// working route to the 111477 catalogue.

var ST_BASE = "https://st.111477.xyz";
var ST_CONFIG_PLAIN = "https://a.111477.xyz/";
var TMDB_KEY = "439c478a771f35c05022f9feabcca01c";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function stConfig() {
  return btoa(ST_CONFIG_PLAIN).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

/** TMDB id -> { imdbId, title, year } (title/year feed the house row name), or null. */
function tmdbImdbId(tmdbId, mediaType) {
  var url = "https://api.themoviedb.org/3/" + (mediaType === "tv" ? "tv" : "movie") + "/" + tmdbId +
    "?api_key=" + TMDB_KEY + "&append_to_response=external_ids";
  return fetchJson(url, { "User-Agent": UA }).then(function (j) {
    if (!j) return null;
    var imdbId = j.imdb_id || (j.external_ids && j.external_ids.imdb_id) || null;
    if (!imdbId) return null;
    return {
      imdbId: imdbId,
      title: j.title || j.name || "",
      year: (j.release_date || j.first_air_date || "").slice(0, 4)
    };
  });
}

/** Quality token exactly as stated in st.'s text ("2160p", "1080p", …). */
function qualityOf(text) {
  var m = String(text || "").match(/(2160p|1440p|1080p|720p|480p|360p|4k)/i);
  if (!m) return "";
  return /4k/i.test(m[1]) ? "2160p" : m[1].toLowerCase();
}

function humanSize(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + " MB";
  return bytes + " B";
}

/** Language tokens in the release name: multi/dub tags, EN/ENG, Hindi, ITA. Else "Original" (port house rule). */
function detectLanguage(name) {
  if (/\b(HIN|TAM|TEL|Multi|Dual|DUB|Multi-Audio|MULTI)\b/i.test(name)) return "Multi Audio";
  if (/\b(EN|ENG|English)\b/i.test(name)) return "English";
  if (/\bHindi\b/i.test(name)) return "Hindi";
  if (/\b(ITA|Italian)\b/i.test(name)) return "Italian";
  return "Original";
}

function cleanName(name) {
  return name.replace(/\.(mkv|mp4|avi|webm|m3u8)$/i, "")
    .replace(/[\[\]()._-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extOf(fileName) {
  var m = String(fileName || "").match(/\.(mkv|mp4|avi|webm|m3u8)$/i);
  return m ? m[1].toUpperCase() : "";
}

/** The "[a11 118.7 GB]" tag -> bytes (1024-based), or undefined. */
function sizeOf(text) {
  var m = String(text || "").match(/\[a11\s+([\d.]+)\s*(GB|MB|KB)\]/i);
  if (!m) return undefined;
  var n = parseFloat(m[1]);
  if (!isFinite(n)) return undefined;
  var unit = m[2].toUpperCase();
  var mult = unit === "GB" ? 1073741824 : unit === "MB" ? 1048576 : 1024;
  return Math.round(n * mult);
}

async function getStreams(tmdbId, mediaType, season, episode) {
  var id = parseInt(tmdbId, 10);
  if (!id || (mediaType !== "movie" && mediaType !== "tv")) return [];
  if (mediaType === "tv" && (season == null || episode == null)) return [];
  try {
    console.log("[111477] Fetching " + mediaType + " " + id +
      (mediaType === "tv" ? " S" + season + "E" + episode : ""));
    var meta = await tmdbImdbId(id, mediaType);
    if (!meta || !meta.imdbId) {
      console.error("[111477] no IMDb id for TMDB " + id);
      return [];
    }
    var imdbId = meta.imdbId;
    var path = mediaType === "tv"
      ? "/stream/series/" + imdbId + ":" + season + ":" + episode + ".json"
      : "/stream/movie/" + imdbId + ".json";
    var data = await fetchJson(ST_BASE + "/config/" + stConfig() + path);
    if (!data || !Array.isArray(data.streams)) {
      console.error("[111477] st. returned no stream list for " + imdbId);
      return [];
    }
    var out = [];
    var seen = {};
    for (var i = 0; i < data.streams.length; i++) {
      var s = data.streams[i] || {};
      var url = typeof s.url === "string" ? s.url : "";
      var title = typeof s.title === "string" ? s.title : "";
      if (url.indexOf("http") !== 0) continue;
      // st.'s IP-flag stub is a notice, not a stream — never a row.
      if (url.indexOf("st.111477.xyz/slowdown") !== -1 || /spammy/i.test(title)) {
        console.error("[111477] st. flagged this connection (Spammy IP stub) for " + imdbId);
        continue;
      }
      if (seen[url]) continue;
      seen[url] = true;
      // House row format (display-only): name = "{Title} {Year} 111477 {Quality}";
      // title = quality | language | size | ext | clean file name. The release
      // name in st.'s title text is the only filename; size/quality are parsed
      // out of that same text (see qualityOf/sizeOf above), never upgraded.
      var fileName = title.replace(/\s*\[a11[^\]]*\]\s*$/i, "").trim();
      var q = qualityOf(title);
      var sz = sizeOf(title);
      var lang = detectLanguage(fileName);
      var ext = extOf(fileName);
      var parts = [];
      if (q) parts.push("\uD83D\uDCFA " + q);
      parts.push("\uD83C\uDF10 " + lang);
      if (sz !== undefined) parts.push("\uD83D\uDCBE " + humanSize(sz));
      if (ext) parts.push("\uD83C\uDF9E\uFE0F " + ext);
      var clean = cleanName(fileName);
      if (clean) parts.push("\u2139\uFE0F " + clean);
      var rowName = meta.title
        ? (meta.title + " " + (meta.year || "") + " 111477 " + (q || "")).replace(/\s+/g, " ").trim()
        : "111477" + (q ? " " + q : "");
      var row = { url: url, name: rowName, title: parts.join("  |  ") };
      if (q) row.quality = q;
      if (sz !== undefined) row.size = sz;
      if (lang !== "Original") row.language = lang;
      out.push(row);
    }
    console.log("[111477] " + imdbId + " -> " + out.length + " streams");
    return out;
  } catch (e) {
    console.error("[111477] " + (e && e.message ? e.message : e));
    return [];
  }
}

if (typeof module !== "undefined" && module.exports) { module.exports = { getStreams }; }
globalThis.getStreams = getStreams;
