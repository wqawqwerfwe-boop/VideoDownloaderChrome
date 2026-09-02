# `src/vendor/`

Browser-ready ES modules loaded directly by the extension. **No build step, no
`node_modules`, no bundler.** `package.json` declares no dependencies on
purpose.

| File | Role | Replaces |
| --- | --- | --- |
| `mp4box.js` | ISO-BMFF box reader + fragmented-MP4 writer | npm `mp4box` |
| `mux.js` | MPEG-2 TS demuxer → fMP4 transmuxer | npm `mux.js` |

## These are not the upstream libraries

They are **purpose-built modules that fill the same role**, written from the
specifications. They are not copies, forks, or minified builds of the npm
packages whose names they echo, and they do not implement those packages' APIs.

The reason is a trust-boundary argument, not a licensing one. This extension
requests `<all_urls>`. Dropping several hundred kilobytes of minified
third-party JavaScript inside that boundary means shipping code that cannot be
reviewed, is not pinned to a hash, and is ~95% unused by us. Two auditable
files that do exactly what the download engine needs is the better trade.

If you would rather run the real upstream libraries, they are drop-in
replaceable at the call sites in `src/offscreen/downloader.js` — but you will
need to add a bundler, and the extension stops being loadable straight from a
`git clone`.

## Supported formats

This matters, because it is exactly the line where Strategy A hands off to the
ffmpeg companion host.

| Input | Handled by | Status |
| --- | --- | --- |
| MPEG-TS, H.264 + AAC-LC | `mux.js` | Transmuxed to MP4 |
| MPEG-TS, H.264 video only | `mux.js` | Transmuxed to MP4 |
| Raw ADTS AAC (audio-only HLS) | `mux.js` | Transmuxed to MP4 |
| fMP4 (`avc1` + `mp4a`), single representation | `mp4box.js` | Concatenated |
| fMP4 (`avc1` + `mp4a`), separate A/V representations | `mp4box.js` | Samples extracted, remuxed to one 2-track file |
| HEVC / H.265 (`hvc1`, `hev1`, stream type 0x24) | — | Detected, **Strategy B** |
| AV1 (`av01`) | — | Detected, **Strategy B** |
| AC-3 / E-AC-3 (`ac-3`, `ec-3`, 0x81, 0x87) | — | Detected, **Strategy B** |
| MP3 in TS (0x03, 0x04), AAC-LATM (0x11) | — | Detected, **Strategy B** |
| Opus, FLAC, Vorbis in MP4 | — | Detected, **Strategy B** |
| WebM / Matroska segments | — | Detected, **Strategy B** |
| Anything with a scrambled TS payload or `cenc`/`cbcs` | — | Refused (see DRM boundary) |

The important property is that unrecognised input is **detected and reported**,
never guessed at. Both modules surface what they could not identify so the
engine can hand the job to ffmpeg, rather than writing an `.mp4` with a `moov`
that lies about its contents — which is the failure mode that produces a file
that looks fine until you try to play it.

## Correctness notes

Things that are easy to get subtly wrong, and how they are handled:

- **33-bit PTS/DTS rollover.** MPEG-TS timestamps wrap roughly every 26.5
  hours, and mid-stream ad insertion can make them jump. `mux.js` unwraps
  monotonically rather than trusting raw values.
- **Timestamps above 2^31.** A 33-bit value cannot be assembled with `<<`,
  which is a 32-bit signed operation in JavaScript. Both modules use
  multiplication.
- **`trun` composition offsets.** Declared unsigned in version 0 and signed in
  version 1. The writer emits version 0 and clamps at zero; the reader honours
  whichever version it finds.
- **`data_offset` is relative to the `moof`.** The writer sets
  `default-base-is-moof` and back-patches offsets by measuring the assembled
  `moof` (its fields are fixed-width, so the measurement holds). The reader
  validates the computed range against the `mdat` and falls back to sequential
  reads if it does not fit.
- **Sample-entry fixed-field sizes.** `VisualSampleEntry` is 78 bytes before
  child boxes, `AudioSampleEntry` is 28. Getting these wrong silently
  mis-locates `avcC` / `esds`.
- **ID3 in front of segments.** HLS routinely prepends an ID3v2 tag with
  syncsafe (7-bit) length bytes to TS and ADTS segments. Skipped before
  sniffing.
- **Verbatim config boxes.** When remuxing fMP4, the source `avcC` / `esds` are
  re-emitted byte for byte rather than reconstructed, preserving details the
  writer does not model.
