// Altadefinizione — Italian movies & series (ITA dub) from
// altadefinizionex.stream, resolved on-device. PlugX v1.0.0.
// The site (and its sister shells Guardaserie / Il Genio dello
// Streaming) is a thin catalogue: every title page points at one
// player host, v.vidxgo.co, and the embed URL is a pure function
// of the IMDb id — https://v.vidxgo.co/<imdb-numeric> for a movie,
// https://v.vidxgo.co/<imdb-numeric>/<season>/<episode>?se=0 for
// an episode. Guardaserie's pages mark their items
// data-sound="ITA": the catalogue is Italian-dubbed.
// vidxgo hard-blocks every datacenter IP (proven 2026-11-26 from
// all of our server seats), so no server can resolve it — but the
// plug runs on the user's own connection, which vidxgo accepts.
// Same pattern as the 111477 plug.
// Extraction (two independent open-source implementations agree —
// StreamFlix's VidxGoExtractor and the MammaMia vidxgo extractor,
// cross-checked against EasyProxy's vidxgo extractor):
//   1. Embed page: the player script is XOR-obfuscated — a script
//      block carries a key and an atob('…') payload; base64-decode
//      the payload, XOR each byte with the key repeated, and the
//      clear text holds currentSrc = '<signed HLS url>'.
//   2. Token endpoint: GET https://v.vidxgo.co/t/<imdb-numeric>
//      (series: /t/<imdb-numeric>/<season>/<episode>) answers
//      JSON {"url": "<signed HLS url>", "expire": …}. The signed
//      URL lives only a few minutes — the plug resolves at tap
//      time, so that is enough to start playback.
//   3. Fallback host (Guardaserie's "player alternativo"):
//      https://vixsrc.to/movie/<imdb-tt>?lang=it and
//      /tv/<imdb-tt>/<season>/<episode>?lang=it — the page carries
//      window.masterPlaylist {url, token, expires}; the playlist
//      URL is rebuilt with lang=it (same parsing as the PlugX
//      Vixsrc plug, which builds the lang=en form).
// Playback headers are the ones the sources themselves specify:
// vidxgo rows need Referer/Origin https://v.vidxgo.co (both
// MammaMia and EasyProxy send exactly those for the media);
// vixsrc rows carry its Referer, as the Vixsrc plug's rows do.
// Quality is never stated by these endpoints before the playlist
// is read, so no quality is claimed on the rows (Vixsrc plug's
// house rule); the language is Italian, per the source's own
// ITA marking. No size is known, so none is shown.

var SITE = "https://altadefinizionex.stream";
var VX = "https://v.vidxgo.co";
var VIX = "https://vixsrc.to";
var TMDB_KEY = "439c478a771f35c05022f9feabcca01c";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

var VX_PLAY_HEADERS = { "User-Agent": UA, "Referer": VX + "/", "Origin": VX };
var VX_TOKEN_HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json, text/plain, */*",
  "Referer": VX + "/",
  "Origin": VX,
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin"
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

/** TMDB id -> { imdbId, title, year }, or null. */
function tmdbMeta(tmdbId, mediaType) {
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

/** XOR-decrypt one obfuscated payload: base64 -> bytes -> XOR with the key repeated. */
function xorDecrypt(b64, key) {
  var bin;
  try { bin = atob(b64); } catch (e) { return ""; }
  var out = "";
  for (var i = 0; i < bin.length; i++) {
    out += String.fromCharCode((bin.charCodeAt(i) & 0xff) ^ (key.charCodeAt(i % key.length) & 0xff));
  }
  return out;
}

/**
 * Find currentSrc in an embed page. Script blocks are tried in
 * order; two key/data shapes are recognised (the two published
 * extractors each use one of them). Returns the URL or null.
 */
function extractFromEmbed(html) {
  if (!html) return null;
  var blocks = html.match(/<script[\s\S]*?<\/script>/gi) || [];
  for (var b = 0; b < blocks.length; b++) {
    var s = blocks[b];
    var key = null, data = null;
    var m1 = s.match(/var\s+\w+\s*=\s*'([^']+)'\s*,\s*d\s*=\s*atob\('([^']+)'\)/);
    if (m1) { key = m1[1]; data = m1[2]; }
    if (!key) {
      var mk = s.match(/var\s+k\s*=\s*['"]([^'"]+)['"]/);
      var md = s.match(/atob\(['"]([^'"]+)['"]\)/);
      if (mk && md) { key = mk[1]; data = md[1]; }
    }
    if (!key || !data) continue;
    var clear = xorDecrypt(data, key);
    if (!clear) continue;
    var u = clear.match(/currentSrc\s*=\s*['"]([^'"]+)['"]/) ||
            clear.match(/currentSrc[^"']*"(https:[^"]+)"/);
    if (u && u[1]) return u[1].replace(/\\\//g, "/").replace(/\\/g, "");
  }
  return null;
}

/** Route 1 — vidxgo embed page (XOR currentSrc). */
function vidxgoEmbed(num, mediaType, season, episode) {
  var url = mediaType === "tv"
    ? VX + "/" + num + "/" + season + "/" + episode + "?se=0"
    : VX + "/" + num;
  return fetchText(url, { "User-Agent": UA, "Referer": SITE + "/", "Sec-Fetch-Dest": "iframe" })
    .then(function (html) { return extractFromEmbed(html); });
}

/** Route 2 — vidxgo /t/ token endpoint (JSON url). */
function vidxgoToken(num, mediaType, season, episode) {
  var url = mediaType === "tv"
    ? VX + "/t/" + num + "/" + season + "/" + episode
    : VX + "/t/" + num;
  return fetchJson(url, VX_TOKEN_HEADERS).then(function (j) {
    if (!j || typeof j.url !== "string") return null;
    var u = j.url.replace(/\\\//g, "/").replace(/\\/g, "");
    return u.indexOf("http") === 0 ? u : null;
  });
}

/** Route 3 — vixsrc Italian player (window.masterPlaylist, lang=it). */
function vixsrcIt(imdbId, mediaType, season, episode) {
  var url = mediaType === "tv"
    ? VIX + "/tv/" + imdbId + "/" + season + "/" + episode + "?lang=it"
    : VIX + "/movie/" + imdbId + "?lang=it";
  return fetchText(url, { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" })
    .then(function (html) {
      if (!html) return null;
      if (html.indexOf("window.masterPlaylist") !== -1) {
        var um = html.match(/url:\s*['"]([^'"]+)['"]/);
        var tk = html.match(/['"]?token['"]?\s*:\s*['"]([^'"]+)['"]/);
        var ex = html.match(/['"]?expires['"]?\s*:\s*['"]([^'"]+)['"]/);
        if (um && tk && ex) {
          var sep = um[1].indexOf("?b=1") !== -1 ? "&" : "?";
          return um[1] + sep + "token=" + tk[1] + "&expires=" + ex[1] + "&h=1&lang=it";
        }
      }
      var m = html.match(/(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)/);
      return m ? m[1] : null;
    });
}

async function getStreams(tmdbId, mediaType, season, episode) {
  var id = parseInt(tmdbId, 10);
  if (!id || (mediaType !== "movie" && mediaType !== "tv")) return [];
  if (mediaType === "tv" && (season == null || episode == null)) return [];
  try {
    console.log("[Altadefinizione] Fetching " + mediaType + " " + id +
      (mediaType === "tv" ? " S" + season + "E" + episode : ""));
    var meta = await tmdbMeta(id, mediaType);
    if (!meta || !meta.imdbId) {
      console.error("[Altadefinizione] no IMDb id for TMDB " + id);
      return [];
    }
    var imdbId = meta.imdbId;
    var num = imdbId.replace(/^tt/, "");
    if (!/^\d+$/.test(num)) {
      console.error("[Altadefinizione] unexpected IMDb id " + imdbId);
      return [];
    }
    var rowName = meta.title
      ? (meta.title + " " + (meta.year || "") + " Altadefinizione").replace(/\s+/g, " ").trim()
      : "Altadefinizione";
    var rowTitle = "\uD83C\uDF10 Italian  |  \uD83C\uDF9E\uFE0F M3U8";
    var out = [];
    var seen = {};
    function addRow(url, headers) {
      if (!url || url.indexOf("http") !== 0 || seen[url]) return;
      seen[url] = true;
      out.push({ url: url, name: rowName, title: rowTitle, language: "Italian", headers: headers });
    }

    var vxUrl = await vidxgoEmbed(num, mediaType, season, episode);
    if (!vxUrl) {
      console.error("[Altadefinizione] vidxgo embed gave no stream for " + imdbId + ", trying /t/");
      vxUrl = await vidxgoToken(num, mediaType, season, episode);
    }
    if (vxUrl) addRow(vxUrl, VX_PLAY_HEADERS);
    else console.error("[Altadefinizione] vidxgo unreachable for " + imdbId + " (host fences datacenter IPs; on-device it should answer)");

    var vixUrl = await vixsrcIt(imdbId, mediaType, season, episode);
    if (vixUrl) addRow(vixUrl, { "User-Agent": UA, "Referer": VIX });
    else console.error("[Altadefinizione] vixsrc-it gave no stream for " + imdbId);

    console.log("[Altadefinizione] " + imdbId + " -> " + out.length + " streams");
    return out;
  } catch (e) {
    console.error("[Altadefinizione] " + (e && e.message ? e.message : e));
    return [];
  }
}

if (typeof module !== "undefined" && module.exports) { module.exports = { getStreams }; }
globalThis.getStreams = getStreams;
