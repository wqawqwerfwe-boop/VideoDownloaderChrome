# OpenVideo Downloader

An open-source, Manifest V3 Chrome extension that detects and downloads media streams:
progressive files (MP4 / WebM / MKV / MP3), HLS (`.m3u8`) and MPEG-DASH (`.mpd`).

No paywalls. No premium tiers. No token buckets. No trial timers. No watermarks.
No artificial throttling or cooling periods. MIT licensed.

## Status

`v0.2.0` — **complete**. Detection, both download strategies and the native companion
host are implemented. No build step: clone and load unpacked.

| Capability | State |
| --- | --- |
| Network sniffing (`chrome.webRequest` observers) | Working |
| DOM + MSE detection (content scripts) | Working |
| HLS master/media playlist parsing | Working |
| DASH MPD parsing (SW-safe, no `DOMParser`) | Working |
| ABR quality ladder in popup | Working |
| Per-tab badge counter | Working |
| Progressive download | Working |
| Segmented HLS/DASH download (Strategy A) | Working |
| AES-128 decrypt + remux to MP4 | Working |
| Live progress, speed and ETA in popup | Working |
| Automatic fallback to the companion host | Working |
| Companion FFmpeg host (Strategy B) | Working |

### Known limits

- The vendored in-browser remuxer covers **H.264 video + AAC-LC audio**. HEVC, VP9, AV1,
  Opus, FLAC and E-AC-3 are detected and routed straight to the companion host rather
  than attempted and failed.
- Merging *separate* audio and video sources buffers in memory, up to ~1.5 GB, then
  escalates to the companion. Single-source streams (audio already muxed into the video
  segments, which is the common HLS case) stream to disk and have no such ceiling.
- Live streams are labelled and refused. There is no meaningful "100%" for them.
- `manifest.json` intentionally ships **without** an `icons` key — see
  [`docs/INSTALL.md`](docs/INSTALL.md#about-the-missing-icons).

## Install

**Extension:** `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select this folder. Requires Chrome 116+.

**Companion host** (optional, only needed for streams Strategy A cannot finish):

```bash
cd companion_app
bash install.sh <YOUR_EXTENSION_ID>     # macOS / Linux
install.bat <YOUR_EXTENSION_ID>         # Windows
```

Requires Python 3.7+ and `ffmpeg` on `PATH`. Full walkthrough, including every failure
mode worth knowing about, is in [`docs/INSTALL.md`](docs/INSTALL.md).

## Scope

This project implements **generic** stream handling that works across a wide range of sites.
It deliberately does **not** include:

- DRM circumvention of any kind (Widevine / PlayReady / FairPlay / Sample-AES). Protected
  streams are detected and reported as unsupported rather than attempted. The companion
  host repeats this check independently, so it cannot be used to route around the refusal.
- Site-specific modules built to defeat a particular platform's access controls.

Standard HLS AES-128 transport encryption (RFC 8216, key published in the manifest) is
supported, as it is in every conformant HLS player. This is not DRM and is not treated as
such: there is no licence server, no key escrow and no usage policy attached to it.

Use this on content you have the right to download.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how detection, the cascade and the
  companion protocol fit together.
- [`docs/INSTALL.md`](docs/INSTALL.md) — installation and troubleshooting.
