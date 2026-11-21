// PlavioPlug — Mapple (standalone on-device scraper)
// Port of the PlavioHD Mapple lane (mapple.fun). Every leg runs
// directly against mapple.fun from the device — no Plavio server,
// no proxy: the site's own session flow is cookie-based and its
// proof-of-work is a plain SHA-256 puzzle solved locally.
//   GET  /                       (mobile UA; harvest cookies)
//   POST /api/ui/session         -> { token }  (request token,
//     cached at module level for its ~6h server-declared TTL)
//   POST /api/playback-init      { mediaId, mediaType, tv_slug,
//     requestToken }             -> playback token, or
//     { requiresPow, pow: { challengeId, challenge, difficulty } };
//     on the PoW branch find a nonce with SHA-256(challenge+nonce)
//     carrying `difficulty` leading zero bits and POST again with
//     pow: { challengeId, nonce } -> { token }.
//   Per server: POST /api/encrypt { data: { mediaId, mediaType,
//     tv_slug, source? }, endpoint: "stream-encrypted",
//     requestToken } -> { url }; GET <url>&requestToken=..&token=..
//     -> { data: { stream_url } } ("playback-unavailable" or
//     success:false means that server has nothing — fail soft).
//   GET the signed master playlist with the playback headers and
//   measure its variants.
// mediaId is the TMDB id; tv_slug is "<season>-<episode>".
// SERVERS: Poseidon (source "s25") is the distinct premium lane.
// Zeus (source "mapple") and Aphrodite / Hephaestus / Atlas (keyed
// servers called with NO source field) return the byte-identical
// master, so one family member is asked — Zeus first, falling
// through only on error/empty. Prometheus is never asked (slow
// CONTENT_NOT_FOUND in every proof).
// QUALITY IS MEASURED: from the master's own RESOLUTION entries —
// width >= 3840 or height >= 2160 -> 2160, width >= 1920 or
// height >= 1080 -> 1080; anything lower is dropped.
// Playback headers (desktop UA + mapple.fun Referer/Origin) ride
// on every row. Final URLs are session-minted signed links —
// re-minted per request, never cached.
// PoW hashing prefers node crypto when the runtime offers it and
// falls back to crypto-js (the vidrock precedent).

var BASE = "https://mapple.fun";
var MOBILE_UA = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
var DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
var TIMEOUT_MS = 15000;
var PLAYBACK_HEADERS = { "User-Agent": DESKTOP_UA, "Referer": BASE + "/", "Origin": BASE };
var POSEIDON = { name: "Poseidon", source: "s25" };
var ZEUS_FAMILY = [
  { name: "Zeus", source: "mapple" },
  { name: "Aphrodite", key: "s6" },
  { name: "Hephaestus", key: "s15" },
  { name: "Atlas", key: "s1" }
];
var POW_MAX_NONCE = 3000000; // ~10x the difficulty-18 expectation
var REQUEST_TOKEN_SKEW_MS = 60000;

var nodeCrypto = null;
try { nodeCrypto = require("crypto"); } catch (e) { nodeCrypto = null; }
var CryptoJS = null;
if (!nodeCrypto) {
  try { CryptoJS = require("crypto-js"); } catch (e) { CryptoJS = null; }
}

/* ---------------- hashing / proof of work ---------------- */

function sha256Bytes(str) {
  if (nodeCrypto) {
    var buf = nodeCrypto.createHash("sha256").update(String(str), "utf8").digest();
    return new Uint8Array(buf);
  }
  var wa = CryptoJS.SHA256(String(str));
  var out = new Uint8Array(32);
  for (var i = 0; i < 32; i++) {
    var word = wa.words[i >> 2] | 0;
    out[i] = (word >>> (24 - 8 * (i % 4))) & 0xff;
  }
  return out;
}

function hasLeadingZeroBits(bytes, difficulty) {
  var fullBytes = Math.floor(difficulty / 8);
  var rem = difficulty % 8;
  for (var i = 0; i < fullBytes; i++) if (bytes[i] !== 0) return false;
  if (rem > 0 && (bytes[fullBytes] >> (8 - rem)) !== 0) return false;
  return true;
}

function solveProofOfWork(challenge, difficulty) {
  if (!nodeCrypto && !CryptoJS) return null;
  for (var nonce = 0; nonce <= POW_MAX_NONCE; nonce++) {
    if (hasLeadingZeroBits(sha256Bytes(String(challenge) + String(nonce)), difficulty)) {
      return String(nonce);
    }
  }
  return null;
}

/* ---------------- transport ---------------- */

function fetchRaw(url, options, timeoutMs) {
  var opts = {};
  options = options || {};
  Object.keys(options).forEach(function (k) { opts[k] = options[k]; });
  opts.redirect = "follow";
  var ctl = null;
  var timer = null;
  if (typeof AbortController !== "undefined") {
    ctl = new AbortController();
    opts.signal = ctl.signal;
    timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, timeoutMs || TIMEOUT_MS);
  }
  return fetch(url, opts).then(function (r) {
    if (timer) clearTimeout(timer);
    return r;
  }).catch(function () {
    if (timer) clearTimeout(timer);
    return null;
  });
}

function fetchJson(url, options, timeoutMs) {
  return fetchRaw(url, options, timeoutMs).then(function (r) {
    if (!r || !r.ok) return null;
    return r.json().catch(function () { return null; });
  });
}

/* ---------------- cookie jar ---------------- */

function createJar() {
  var cookies = {};
  return {
    update: function (response) {
      try {
        var raw = [];
        if (response && response.headers) {
          if (typeof response.headers.getSetCookie === "function") {
            raw = response.headers.getSetCookie() || [];
          } else if (typeof response.headers.get === "function") {
            var combined = response.headers.get("set-cookie");
            if (combined) raw = combined.split(/,\s*(?=[^;,=]+?=)/);
          }
        }
        raw.forEach(function (cookie) {
          var pair = String(cookie).split(";")[0].split("=");
          if (pair.length >= 2) cookies[pair[0].replace(/^\s+|\s+$/g, "")] = pair.slice(1).join("=").replace(/^\s+|\s+$/g, "");
        });
      } catch (e) { /* no cookies — the flow fails soft downstream */ }
    },
    serialize: function () {
      return Object.keys(cookies).map(function (k) { return k + "=" + cookies[k]; }).join("; ");
    }
  };
}

function apiHeaders(referer, isJson, jar) {
  var headers = { "User-Agent": MOBILE_UA, "Accept": "*/*", "Origin": BASE, "Referer": referer };
  if (isJson) headers["Content-Type"] = "application/json";
  var cookie = jar.serialize();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/* ---------------- request-token session (cached ~6h) ---------------- */

var requestSessionCache = null; // { requestToken, jar, expiresAtMs }
var requestSessionInflight = null;

function fetchRequestSession(referer) {
  var jar = createJar();
  return fetchRaw(BASE + "/", { headers: { "User-Agent": MOBILE_UA, "Accept": "text/html" } })
    .then(function (home) {
      if (!home) return null;
      jar.update(home);
      return home.text().catch(function () { return ""; }).then(function () {
        return fetchRaw(BASE + "/api/ui/session", {
          method: "POST",
          headers: apiHeaders(referer, true, jar),
          body: ""
        });
      });
    })
    .then(function (tokenResponse) {
      if (!tokenResponse || !tokenResponse.ok) return null;
      jar.update(tokenResponse);
      return tokenResponse.json().catch(function () { return null; }).then(function (tokenData) {
        var requestToken = tokenData && tokenData.token;
        if (!requestToken) return null;
        var expiresAtMs = 0;
        var expAt = Number(tokenData.expiresAt);
        var expIn = Number(tokenData.expiresIn);
        if (isFinite(expAt) && expAt > Date.now()) expiresAtMs = expAt;
        else if (isFinite(expIn) && expIn > 0) expiresAtMs = Date.now() + expIn;
        return { requestToken: requestToken, jar: jar, expiresAtMs: expiresAtMs };
      });
    })
    .catch(function () { return null; });
}

function getRequestSession(referer) {
  if (requestSessionCache && Date.now() < requestSessionCache.expiresAtMs - REQUEST_TOKEN_SKEW_MS) {
    return Promise.resolve({ session: requestSessionCache, fromCache: true });
  }
  if (!requestSessionInflight) {
    requestSessionInflight = fetchRequestSession(referer).then(function (s) {
      if (s && s.expiresAtMs > Date.now() + REQUEST_TOKEN_SKEW_MS) requestSessionCache = s;
      requestSessionInflight = null;
      return s;
    });
  }
  return requestSessionInflight.then(function (session) {
    return session ? { session: session, fromCache: false } : null;
  });
}

function dropRequestSession(session) {
  if (requestSessionCache === session) requestSessionCache = null;
}

/* ---------------- playback token: PoW-gated, per title ---------------- */

function mintPlaybackToken(query, session) {
  var initBody = {
    mediaId: query.mediaId,
    mediaType: query.mediaType,
    tv_slug: query.tvSlug,
    requestToken: session.requestToken
  };
  function initCall(body) {
    return fetchRaw(BASE + "/api/playback-init", {
      method: "POST",
      headers: apiHeaders(query.referer, true, session.jar),
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r) return null;
      session.jar.update(r);
      return r.json().catch(function () { return null; });
    });
  }
  return initCall(initBody).then(function (init) {
    if (init && init.requiresPow && init.pow) {
      var nonce = solveProofOfWork(init.pow.challenge, init.pow.difficulty || 18);
      if (nonce === null) return null;
      var body = {
        mediaId: initBody.mediaId,
        mediaType: initBody.mediaType,
        tv_slug: initBody.tv_slug,
        requestToken: initBody.requestToken,
        pow: { challengeId: init.pow.challengeId, nonce: nonce }
      };
      return initCall(body);
    }
    return init;
  }).then(function (init) {
    return (init && init.token) || null;
  });
}

/* ---------------- master playlist -> measured variants ---------------- */

function qualityOf(width, height) {
  if (width >= 3840 || height >= 2160) return 2160;
  if (width >= 1920 || height >= 1080) return 1080;
  return 0;
}

function parseMaster(text, baseUrl) {
  var lines = String(text || "").split("\n");
  var out = [];
  var pending = null;
  lines.forEach(function (rawLine) {
    var line = rawLine.replace(/^\s+|\s+$/g, "");
    if (line.indexOf("#EXT-X-STREAM-INF") === 0) {
      var res = /RESOLUTION=(\d+)x(\d+)/.exec(line);
      var bw = /BANDWIDTH=(\d+)/.exec(line);
      pending = {
        quality: res ? qualityOf(parseInt(res[1], 10), parseInt(res[2], 10)) : 0,
        bandwidth: bw ? parseInt(bw[1], 10) : 0
      };
    } else if (line && line.charAt(0) !== "#") {
      if (pending && pending.quality) {
        try {
          out.push({ url: new URL(line, baseUrl).toString(), quality: pending.quality, bandwidth: pending.bandwidth });
        } catch (e) { /* unresolvable variant path — skip it */ }
      }
      pending = null;
    }
  });
  return out;
}

function qualityLabel(q) {
  return q === 2160 ? "4K" : q + "p";
}

/* ---------------- per-lane chains: encrypt, then stream ---------------- */

// /api/encrypt needs only the request token; the calls fire
// once the playback token is minted (see the ORDER NOTE below).
function encryptServerUrl(server, query, session) {
  var data = { mediaId: query.mediaId, mediaType: query.mediaType, tv_slug: query.tvSlug };
  if (server.source !== undefined) data.source = server.source;
  return fetchJson(BASE + "/api/encrypt", {
    method: "POST",
    headers: apiHeaders(query.referer, true, session.jar),
    body: JSON.stringify({ data: data, endpoint: "stream-encrypted", requestToken: session.requestToken })
  }).then(function (encrypted) {
    return (encrypted && encrypted.url) || null;
  }).catch(function () { return null; });
}

function variantsFromEncryptedUrl(encryptedUrl, serverName, query, session) {
  var streamEndpoint =
    BASE + encryptedUrl +
    "&requestToken=" + encodeURIComponent(session.requestToken) +
    "&token=" + encodeURIComponent(session.playbackToken);
  return fetchJson(streamEndpoint, {
    headers: apiHeaders(query.referer, false, session.jar)
  }).then(function (streamData) {
    var streamUrl = streamData && streamData.success && streamData.data && streamData.data.stream_url;
    if (!streamUrl || String(streamUrl).indexOf("playback-unavailable") >= 0) return [];
    return fetchRaw(streamUrl, { headers: PLAYBACK_HEADERS }).then(function (master) {
      if (!master || !master.ok) return [];
      return master.text().catch(function () { return ""; }).then(function (text) {
        if (!text || text.indexOf("#EXT-X-STREAM-INF") < 0) return [];
        return parseMaster(text, streamUrl).map(function (v) {
          v.server = serverName;
          return v;
        });
      });
    });
  }).catch(function () { return []; });
}

// One family member is enough (byte-identical masters); fall
// through to the next only on error or an empty answer.
function fetchZeusFamilyVariants(query, session, firstEncrypt, index) {
  index = index || 0;
  if (index >= ZEUS_FAMILY.length) return Promise.resolve([]);
  var server = ZEUS_FAMILY[index];
  var urlPromise = (index === 0 && firstEncrypt) ? firstEncrypt : encryptServerUrl(server, query, session);
  return urlPromise.then(function (url) {
    if (!url) return fetchZeusFamilyVariants(query, session, null, index + 1);
    return variantsFromEncryptedUrl(url, server.name, query, session).then(function (variants) {
      if (variants.length) return variants;
      return fetchZeusFamilyVariants(query, session, null, index + 1);
    });
  }).catch(function () {
    return fetchZeusFamilyVariants(query, session, null, index + 1);
  });
}

// One full title flow against a request session. Resolves the
// deduped variant list, or null when the playback token could
// not be minted at all (a session-level failure — the caller
// may retry once on a fresh request token).
// ORDER NOTE: the server recipe fires the encrypt calls before
// the PoW solve so they overlap it, but on this wire the
// session cookie rotates per response and a playback-init
// fired while encrypts are in flight answers 401 "Playback
// session required" (proven in the porting tests). The token
// is therefore minted FIRST, then the encrypts fire.
function runTitleFlow(query, reqSession) {
  return mintPlaybackToken(query, reqSession).then(function (playbackToken) {
    if (!playbackToken) return null;
    var session = {
      requestToken: reqSession.requestToken,
      playbackToken: playbackToken,
      jar: reqSession.jar
    };
    var poseidonEncrypt = encryptServerUrl(POSEIDON, query, reqSession);
    var zeusEncrypt = encryptServerUrl(ZEUS_FAMILY[0], query, reqSession);
    var poseidonVariants = poseidonEncrypt.then(function (url) {
      return url ? variantsFromEncryptedUrl(url, POSEIDON.name, query, session) : [];
    });
    var familyVariants = fetchZeusFamilyVariants(query, session, zeusEncrypt);
    return Promise.all([poseidonVariants, familyVariants]).then(function (lists) {
      var seen = {};
      var found = [];
      lists.forEach(function (variants) {
        variants.forEach(function (v) {
          if (seen[v.url]) return;
          seen[v.url] = true;
          found.push(v);
        });
      });
      return found;
    });
  });
}

/* ---------------- main ---------------- */

function getStreams(tmdbId, mediaType, season, episode) {
  if (!/^\d+$/.test(String(tmdbId || ""))) return Promise.resolve([]);
  var isSeries = mediaType === "tv";
  if (isSeries && (season == null || episode == null)) return Promise.resolve([]);

  var sNum = parseInt(season, 10) || 1;
  var eNum = parseInt(episode, 10) || 1;
  var query = {
    mediaId: Number(tmdbId),
    mediaType: isSeries ? "tv" : "movie",
    tvSlug: isSeries ? sNum + "-" + eNum : "",
    referer: isSeries
      ? BASE + "/tv/" + tmdbId + "/" + sNum + "/" + eNum
      : BASE + "/movie/" + tmdbId
  };

  console.log("[Mapple] Fetching " + query.mediaType + " " + tmdbId +
    (isSeries ? " S" + sNum + "E" + eNum : ""));

  return getRequestSession(query.referer).then(function (first) {
    if (!first) return [];
    return runTitleFlow(query, first.session).then(function (found) {
      if ((found === null || found.length === 0) && first.fromCache) {
        // A cached request token can die before its declared
        // TTL — discard it, fetch a fresh one, retry once.
        dropRequestSession(first.session);
        return fetchRequestSession(query.referer).then(function (fresh) {
          if (!fresh) return found || [];
          if (fresh.expiresAtMs > Date.now() + REQUEST_TOKEN_SKEW_MS) requestSessionCache = fresh;
          return runTitleFlow(query, fresh).then(function (retry) {
            return retry !== null ? retry : (found || []);
          });
        });
      }
      return found || [];
    });
  }).then(function (found) {
    found.sort(function (a, b) {
      return (b.quality - a.quality) || (b.bandwidth - a.bandwidth);
    });
    return found.map(function (v) {
      return {
        name: "Mapple",
        title: v.server + " " + qualityLabel(v.quality),
        url: v.url,
        quality: qualityLabel(v.quality),
        headers: PLAYBACK_HEADERS
      };
    });
  }).catch(function (err) {
    console.error("[Mapple] Error:", err && err.message);
    return [];
  });
}

module.exports = { getStreams };
