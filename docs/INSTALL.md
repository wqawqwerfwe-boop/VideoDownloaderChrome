# Installation

Two pieces, installed separately:

1. **The extension** — required. Handles detection and Strategy A (in-browser download).
2. **The companion host** — optional. A small Python script that drives `ffmpeg` when the
   browser cannot finish a download itself.

The extension works alone. Install the companion when you hit a stream Strategy A gives
up on; the popup tells you when that happens.

---

## Part 1 — Load the extension

There is no build step. No `npm install`, no bundler, no transpile. Every file in this
repository is the file the browser runs.

1. Clone or download the repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository root — the folder containing
   `manifest.json`.

Chrome 116 or newer is required (`minimum_chrome_version` in the manifest). Chromium,
Brave, Edge and Vivaldi work as well.

### Verify it loaded

Open any page with a video and click the toolbar icon. Detected media appears with a
quality ladder. The badge shows a per-tab count.

If the popup is empty on a page you know has video, the stream may not have started
loading yet — detection is driven by network activity, so press play and reopen.

### About the missing icons

`manifest.json` deliberately has **no `icons` key**, and this is worth understanding
before you "fix" it.

Chrome refuses to load an extension whose manifest points at icon files that do not
exist — it is a hard load failure, not a warning. Binary PNGs cannot be committed
through the GitHub contents API used to build this repository, so a manifest listing
`assets/icons/icon16.png` would have shipped a repository that will not load at all.
Omitting the key means Chrome supplies its default puzzle-piece placeholder and
everything works.

To get real icons, open `tools/make-icons.html` in a browser, click through the four
sizes it generates, save them into `assets/icons/`, and add:

```json
"icons": {
  "16": "assets/icons/icon16.png",
  "32": "assets/icons/icon32.png",
  "48": "assets/icons/icon48.png",
  "128": "assets/icons/icon128.png"
}
```

---

## Part 2 — Install the companion host

### Prerequisites

**Python 3.7+**

```bash
python3 --version          # macOS / Linux
py -3 --version            # Windows
```

**ffmpeg**, on `PATH`:

| Platform | Command |
| --- | --- |
| macOS | `brew install ffmpeg` |
| Debian / Ubuntu | `sudo apt install ffmpeg` |
| Fedora | `sudo dnf install ffmpeg` |
| Arch | `sudo pacman -S ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` |

Verify with `ffmpeg -version`.

### Find your extension ID

On `chrome://extensions` with Developer mode on, the ID is the 32-letter string under
**OpenVideo Downloader**, e.g. `abcdefghijklmnopabcdefghijklmnop`.

> **This ID is not stable.** An unpacked extension is assigned a fresh random ID whenever
> it is loaded from a different directory. Chrome will only let a host talk to the exact
> origins listed in its manifest, so if you move or re-clone the folder you must re-run
> the installer with the new ID. The symptom is a "companion host not installed" error
> that looks like a broken install but is actually a stale origin.
>
> To pin the ID permanently, add a `key` field to `manifest.json`
> ([how to derive one](https://developer.chrome.com/docs/extensions/reference/manifest/key)).

### Run the installer

**macOS / Linux**

```bash
cd companion_app
bash install.sh abcdefghijklmnopabcdefghijklmnop
```

(`bash install.sh` rather than `./install.sh` — files committed through the GitHub API do
not carry the executable bit. `chmod +x install.sh` if you prefer.)

**Windows**

```bat
cd companion_app
install.bat abcdefghijklmnopabcdefghijklmnop
```

No administrator rights are needed. Everything is written per-user.

You can pass several IDs to authorise more than one install (e.g. Chrome and Brave):

```bash
bash install.sh <chrome_id> <brave_id>
```

### Then fully quit and reopen the browser

Not just the window — **quit the application**. Chrome reads native messaging host
registrations once at startup and caches them. Until it restarts, a correct install looks
like it did nothing.

### Confirm it worked

Open the popup. The footer shows the companion status, including the detected `ffmpeg`
version. You can also check without the browser:

```bash
python3 companion_app/host.py --probe
```

This prints the host version, the `ffmpeg` it found and the Downloads directory it
resolved, and exits non-zero if `ffmpeg` is missing.

### What the installer actually did

**macOS** — wrote `com.unrestricted.video.downloader.json` into every browser present:

```
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
~/Library/Application Support/Chromium/NativeMessagingHosts/
~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/
~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/
~/Library/Application Support/Vivaldi/NativeMessagingHosts/
```

**Linux** — the same, under `~/.config/google-chrome/NativeMessagingHosts/` and siblings.

**Windows** — the file's location on disk is irrelevant; only the registry matters. The
manifest goes to `%LOCALAPPDATA%\OpenVideoDownloader\` and a per-user key points at it:

```
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.unrestricted.video.downloader
```

The manifest is also pointed at a generated `host.bat` rather than `host.py` directly,
because Windows native messaging cannot reliably execute a `.py` file. The shim invokes
the exact interpreter that ran the installer.

### Uninstall

```bash
bash install.sh --uninstall      # macOS / Linux
install.bat --uninstall          # Windows
```

---

## How a download proceeds

Strategy A is always tried first. It fetches segments in the browser, four at a time,
decrypts AES-128 if present, remuxes to MP4 and saves through `chrome.downloads`.

It escalates to the companion automatically when it cannot finish:

| Reason | Why the browser cannot do it |
| --- | --- |
| `cors_blocked` | The CDN refuses cross-origin reads of the segments |
| `memory_limit` | The assembly would exceed what the document can hold |
| `unsupported_codec` | HEVC / VP9 / AV1 / Opus — no in-browser remuxer |
| `manifest_unparseable` | Non-conformant playlist our parser rejects |
| `quota_exceeded` | No room in the extension's storage |
| `segment_failed`, `network_timeout` | Repeated failures after retries |

Cancellation and DRM refusals are terminal and never escalate — retrying with a different
engine would not change either answer.

When the companion runs, `ffmpeg` writes straight to your Downloads folder, so the file
will not appear in Chrome's download shelf. The popup reports progress and the final path.

---

## Troubleshooting

**"Companion host not installed"** — most often a stale extension ID. Re-check the ID on
`chrome://extensions` and re-run the installer. Otherwise: did you fully quit the browser?

**"Companion installed, but ffmpeg was not found"** — the host is registered and
responding; it just cannot find the binary. A GUI-launched Chrome inherits a minimal
`PATH` that often excludes `/opt/homebrew/bin`, so `ffmpeg` can work in your terminal and
be invisible to the host. The host also probes the usual install locations directly, so
this usually means ffmpeg is somewhere unusual — symlink it into `/usr/local/bin`.

**Downloads stall at 0%** — a stream where the CDN blocks extension-origin reads.
Escalation should be automatic; if it is not, check the host log.

**Stream is labelled "Protected"** — Widevine, PlayReady, FairPlay or Sample-AES was
detected. This is refused by design, in both the extension and the host, and there is no
setting to override it.

**Quality was not what I picked** — if `ffprobe` is missing the host cannot enumerate the
renditions and lets `ffmpeg` choose. It emits a warning saying so. Install `ffprobe`
(it ships with `ffmpeg`) to get exact selection.

### Logs

| What | Where |
| --- | --- |
| Service worker | `chrome://extensions` → **service worker** link |
| Popup | Right-click the popup → **Inspect** |
| Content scripts | The page's own DevTools console |
| Companion host | `~/.openvideo-downloader/host.log`, or `%LOCALAPPDATA%\OpenVideoDownloader\host.log` |

Extension logs are prefixed `[ovd:<scope>]`. Raise verbosity from any extension console:

```js
import("/src/shared/logger.js").then((m) => m.setLogLevel("debug"))
```

The host log is the place to look for `ffmpeg`'s own diagnostics — they cannot be written
to stdout, because stdout carries the native messaging protocol and a single stray byte
would desync the framing.
