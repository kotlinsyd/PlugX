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
      var ql = s.quality || "1080p";
      out.push({
        name: "VidBolt",
        title: ql + " • " + (j.stream.server || "orion") + " • HLS",
        url: s.url,
        quality: ql,
        headers: PLAYBACK_HEADERS
      });
    });
    return out;
  }).catch(function (err) {
    console.error("[VidBolt] Error:", err && err.message);
    return [];
  });
}

module.exports = { getStreams };
