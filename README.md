# OpenVideo Downloader

An open-source, Manifest V3 Chrome extension that detects and downloads media streams:
progressive files (MP4 / WebM / MKV / MP3), HLS (`.m3u8`) and MPEG-DASH (`.mpd`).

No paywalls. No premium tiers. No token buckets. No trial timers. No watermarks.
No artificial throttling or cooling periods. MIT licensed.

## Status

`v0.1.0` — **core layer**. Sniffer, registry, badge, manifest parsers and popup UI are in.
The segmented download orchestrator (offscreen document + worker pool) lands next.

| Capability | State |
| --- | --- |
| Network sniffing (`chrome.webRequest` observers) | Working |
| DOM + MSE detection (content scripts) | Working |
| HLS master/media playlist parsing | Working |
| DASH MPD parsing (SW-safe, no `DOMParser`) | Working |
| ABR quality ladder in popup | Working |
| Per-tab badge counter | Working |
| Progressive download | Working |
| Segmented HLS/DASH download | Next commit |
| AES-128 decrypt + remux | Next commit |
| Companion FFmpeg host | Next commit |

## Install (unpacked)

1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

Requires Chrome 116+.

## Scope

This project implements **generic** stream handling that works across a wide range of sites.
It deliberately does **not** include:

- DRM circumvention of any kind (Widevine / PlayReady / FairPlay). Protected streams are
  detected and reported as unsupported rather than attempted.
- Site-specific modules built to defeat a particular platform's access controls.

Standard HLS AES-128 transport encryption (RFC 8216, key published in the manifest) is
supported, as it is in every conformant HLS player.

Use this on content you have the right to download.

## Docs

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
