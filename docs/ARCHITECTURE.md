# Architecture

## Why a cascade

No single mechanism can download every stream a browser can play, so the
extension tries progressively more capable and progressively more intrusive
strategies and stops at the first one that works.

| | Strategy | Runs in | Handles | Cost |
| --- | --- | --- | --- | --- |
| — | **Direct** | service worker | one addressable file (`.mp4`, `.webm`, `.mp3`) | none — `chrome.downloads` does it, with native pause/resume |
| **A** | **In-browser fetch + remux** | offscreen document | HLS / DASH whose segments are readable with our host permissions | RAM proportional to output size |
| **B** | **Native FFmpeg companion** | local Python host | anything ffmpeg can read: odd codecs, huge files, hostile CORS | one-time install outside the browser |

The boundary between A and B is not a quality judgement, it is a capability
boundary. Strategy A is preferred because it needs nothing installed; Strategy B
exists because three classes of failure are not fixable from inside a browser
tab:

1. **Memory.** Strategy A assembles the output in RAM. A two-hour 1080p stream
   is 3–6 GB. Chrome will kill the document long before that.
2. **Codecs.** The vendored transmuxer understands H.264 + AAC. HEVC, AV1,
   AC-3, E-AC-3 and MP3-in-TS are real and common; ffmpeg handles them all.
3. **Fetch reachability.** Host permissions defeat CORS for us, but not every
   origin can be read this way — some segment endpoints are gated on request
   properties the extension cannot forge.

## Manifest V3 lifetime constraints

These are not style preferences. They dictate the module layout.

- **The service worker is evicted after ~30 s idle.** It therefore owns no
  long-running work and no authoritative in-memory state. Every registry
  mutation is mirrored to `chrome.storage.session` and rehydrated on wake
  (`background/media-registry.js`).
- **A service worker has no DOM and no `URL.createObjectURL`.** It cannot hold
  or hand off a large `Blob`. So the download engine's actual work happens in an
  **offscreen document**, which lives as long as we keep it and has both.
- **`chrome.webRequest` still observes fine in MV3.** Only the *blocking*
  variant was restricted. `declarativeNetRequest` is useless for detection — it
  is declarative by design and never calls back into JavaScript. DNR is used
  only to restore `Referer`/`Origin` on our own fetches
  (`background/net-rules.js`, scoped to `tabIds: [-1]`).
- **`chrome.runtime.sendNativeMessage` is one-shot**: one message, one reply,
  port closed. It cannot stream progress. Long jobs therefore use
  `chrome.runtime.connectNative`, and `sendNativeMessage` is reserved for the
  cheap "are you installed, and what version?" handshake.

## Module map

```
manifest.json                     MV3 manifest, buildless
rules/dnr-header-rules.json       static DNR ruleset (empty; tabIds rules must be session-scoped)

src/content/
  mse-hook.js                     MAIN world: recovers stream URLs behind blob: playback
  dom-observer.js                 ISOLATED world: media elements, incl. open shadow roots

src/background/
  service-worker.js               message router, tab lifecycle, direct downloads
  sniffer.js                      observational chrome.webRequest -> registry
  media-registry.js               per-tab store, mirrored to storage.session
  probe.js                        fetches + parses manifests so the ladder is ready early
  badge.js                        per-tab counter
  net-rules.js                    dynamic Referer/Origin rules for extension fetches
  download-engine.js              job manager; owns the A -> B cascade
  companion.js                    Strategy B transport (connectNative + sendNativeMessage)

src/offscreen/
  offscreen.html                  host page for the engine
  downloader.js                   Strategy A: fetch pool, decrypt, assemble, save

src/engines/
  hls/parser.js                   RFC 8216 master + media playlists
  dash/mpd-parser.js              MPD: SegmentTemplate / SegmentTimeline / SegmentList / single-file
  dash/xml.js                     self-contained XML tokeniser (no DOMParser in a worker)

src/vendor/
  mp4box.js                       ISO-BMFF reader + fMP4 writer
  mux.js                          MPEG-2 TS demuxer -> fMP4 transmuxer

companion_app/                    Strategy B native host (Python + ffmpeg)
```

## Data flow

```
  page traffic ──> sniffer ─┐
  <video>/<source> ─────────┼──> media-registry ──> probe ──> variant ladder
  MSE hook ─────────────────┘                                      │
                                                                   v
                                                                 popup
                                                                   │ JOB_START
                                                                   v
                                                          download-engine
                                                            │          │
                                                  Strategy A│          │Strategy B
                                                            v          v
                                                 offscreen/downloader  companion.js
                                                   fetch x4            connectNative
                                                   AES-128 decrypt         │
                                                   transmux (mux.js)       v
                                                   assemble (mp4box.js) host.py -> ffmpeg
                                                            │              │
                                                            └──> file <────┘
```

## The DRM boundary

This is a deliberate, permanent boundary, not an unfinished feature.

**Detected and refused.** Widevine, PlayReady, FairPlay, and MPEG Common
Encryption (`cenc` / `cbcs`) are identified during probing —
`EXT-X-SESSION-KEY` / `EXT-X-KEY` `KEYFORMAT` for HLS,
`<ContentProtection schemeIdUri>` for DASH. Such entries are marked
`probeState: "unsupported"`, rendered in the popup as **Protected** with the
scheme named, and carry no download button. `download-engine.js` re-checks the
flag before starting and refuses with `FailureCode.DRM_PROTECTED`; the check is
not bypassable from the UI. The companion host applies the same refusal, so
Strategy B is not a back door around Strategy A's check.

**Supported.** HLS AES-128 (RFC 8216 §5.2) is *transport* encryption: the key is
published in the manifest and served over HTTP to any client, precisely so that
every conformant player can decrypt it. Handling it is table stakes for reading
HLS at all, and involves no protected key material and no circumvention of an
access control. `SAMPLE-AES` is treated as DRM, because in practice it is
FairPlay.

The practical reason to draw the line here and enforce it in both strategies:
content behind a real DRM system is behind a technical protection measure, and
defeating one is a different act — legally and ethically — from remuxing a
stream you can already fetch. Users remain responsible for having the right to
download what they point this at.
