// 111477 — wraps the official 111477 addon (st.111477.xyz) from the
// device. The plug asks st. for streams itself, on the user's own
// connection, and returns the worker links st. mints. No Plavio
// server is involved at any point.
// Chain:
//   TMDB id -> IMDb id (TMDB API; public community key, the same
//   one the other PlugX plugs use)
//   GET https://st.111477.xyz/config/<cfg>/stream/movie/<imdb>.json
//   GET https://st.111477.xyz/config/<cfg>/stream/series/<imdb>:<s>:<e>.json
//   <cfg> = url-safe base64 (no padding) of the public no-key
//   config "https://a.111477.xyz/::sort=file-desc::limit=3" —
//   st. returns streams for it without any TMDB key, so none is
//   embedded here.
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
var ST_CONFIG_PLAIN = "https://a.111477.xyz/::sort=file-desc::limit=3";
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

/** TMDB id -> IMDb id (tt…), or null. */
function tmdbImdbId(tmdbId, mediaType) {
  var url = "https://api.themoviedb.org/3/" + (mediaType === "tv" ? "tv" : "movie") + "/" + tmdbId +
    "?api_key=" + TMDB_KEY + "&append_to_response=external_ids";
  return fetchJson(url, { "User-Agent": UA }).then(function (j) {
    if (!j) return null;
    if (j.imdb_id) return j.imdb_id;
    if (j.external_ids && j.external_ids.imdb_id) return j.external_ids.imdb_id;
    return null;
  });
}

/** Quality token exactly as stated in st.'s text ("2160p", "1080p", …). */
function qualityOf(text) {
  var m = String(text || "").match(/(2160p|1440p|1080p|720p|480p|360p)/i);
  return m ? m[1].toLowerCase() : "";
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
    var imdbId = await tmdbImdbId(id, mediaType);
    if (!imdbId) {
      console.error("[111477] no IMDb id for TMDB " + id);
      return [];
    }
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
      var row = { url: url, name: "111477", title: title };
      var q = qualityOf(title);
      if (q) row.quality = q;
      var sz = sizeOf(title);
      if (sz !== undefined) row.size = sz;
      out.push(row);
    }
    console.log("[111477] " + imdbId + " -> " + out.length + " streams");
    return out;
  } catch (e) {
    console.error("[111477] " + (e && e.message ? e.message : e));
    return [];
  }
}

module.exports = { getStreams };
