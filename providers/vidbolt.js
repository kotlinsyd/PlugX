// PlavioPlug — VidBolt (standalone on-device scraper)
// Port of the PlavioHD VidBolt lane (vidbolt.xyz), server-free:
//   GET https://vidbolt.xyz/api/resolve?type=movie&id=<tmdbId>
//   GET https://vidbolt.xyz/api/resolve?type=tv&id=<tmdbId>&season=<s>&episode=<e>
//       -> { stream: { server, sources: [{ url, kind: "hls",
//          quality, master }] } }  — the url is a direct HLS master
//          playlist on img.rousav.tech with a per-resolve api_key.
// The master itself lists 1080p / 720p / 480p variants plus English
// and Hindi audio tracks. The api_key is minted per resolve and is
// short-lived (a key probed minutes after its resolve no longer
// serves; a fresh key serves at once), so the plug returns the
// freshly resolved URL and nothing is cached — the player and the
// app's dead-row probe both run within seconds of the resolve.
// No TMDB key needed: the API is keyed by TMDB id directly.
// Playback headers: desktop UA + vidbolt.xyz Referer on every row.

var BASE = "https://vidbolt.xyz";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var FETCH_HEADERS = {
  "User-Agent": UA,
  "Referer": BASE + "/",
  "Accept": "application/json"
};
var PLAYBACK_HEADERS = {
  "User-Agent": UA,
  "Referer": BASE + "/"
};

function fetchJson(url) {
  return fetch(url, { redirect: "follow", headers: FETCH_HEADERS })
    .then(function (r) { if (!r.ok) return null; return r.json().catch(function () { return null; }); })
    .catch(function () { return null; });
}

/* ---------------- house row format (display-only) ----------------
   "4K" normalises to "2160p". No TMDB lookup: the API is keyed by
   TMDB id directly, so no title/year is known and the name stays
   "VidBolt {Quality}". The resolve API gives a quality per source
   (no quality is claimed when it gives none). The master playlist
   carries English + Hindi audio tracks (plug's own chain note), so
   🌐 is "English + Hindi"; every row is an HLS master (🎞️ M3U8).
   No file size or filename exists; the server name rides in ℹ️. */
function normalizeQuality(q) {
  if (!q) return "";
  var s = String(q).trim();
  if (/^4k$/i.test(s)) return "2160p";
  return s;
}

function getStreams(tmdbId, mediaType, season, episode) {
  if (!/^\d+$/.test(String(tmdbId || ""))) return Promise.resolve([]);
  var apiType = mediaType === "tv" ? "tv" : "movie";
  if (apiType === "tv" && (season == null || episode == null)) return Promise.resolve([]);

  console.log("[VidBolt] Fetching " + apiType + " " + tmdbId +
    (apiType === "tv" ? " S" + season + "E" + episode : ""));

  var q = "type=" + apiType + "&id=" + tmdbId;
  if (apiType === "tv") q += "&season=" + season + "&episode=" + episode;

  return fetchJson(BASE + "/api/resolve?" + q).then(function (j) {
    if (!j || !j.stream || !j.stream.sources || !j.stream.sources.length) return [];
    var seen = {};
    var out = [];
    j.stream.sources.forEach(function (s) {
      if (!s || !s.url || !/^https:\/\//i.test(s.url)) return;
      if (seen[s.url]) return;
      seen[s.url] = true;
      var ql = normalizeQuality(s.quality);
      var parts = [];
      if (ql) parts.push("📺 " + ql);
      parts.push("🌐 English + Hindi");
      parts.push("🎞️ M3U8");
      parts.push("ℹ️ " + (j.stream.server || "orion"));
      var row = {
        name: ql ? "VidBolt " + ql : "VidBolt",
        title: parts.join("  |  "),
        url: s.url,
        language: "English + Hindi",
        headers: PLAYBACK_HEADERS
      };
      if (ql) row.quality = ql;
      out.push(row);
    });
    return out;
  }).catch(function (err) {
    console.error("[VidBolt] Error:", err && err.message);
    return [];
  });
}

if (typeof module !== "undefined" && module.exports) { module.exports = { getStreams }; }
globalThis.getStreams = getStreams;
