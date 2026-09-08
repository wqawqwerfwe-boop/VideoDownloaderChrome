#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OpenVideo Downloader - native messaging companion host (Strategy B).

Strategy A runs inside the browser's security model, which is exactly why it
sometimes cannot finish: a cross-origin segment read may be refused, a
multi-gigabyte assembly may exhaust the tab's memory, and an exotic codec has
no in-browser remuxer. None of those constraints apply to a local ffmpeg
process - provided it is handed the same credentials the browser had. This
host is that handoff.

Protocol (Chrome native messaging): each message is a 4-byte length prefix in
native byte order followed by that many bytes of UTF-8 JSON.

Requests understood:

    {"action": "ping",     "protocol": 1}
    {"action": "download", "protocol": 1, "jobId": "...", "manifestUrl": "...",
     "filename": "...", "headers": {...}, "duration": 123.4,
     "quality": {"height": 1080, ...}, "stream": true}
    {"action": "cancel",   "protocol": 1, "jobId": "..."}

Responses emitted:

    {"ok": true, "version": "...", "ffmpeg": {...}, "downloadsDir": "..."}
    {"type": "progress", "jobId": "...", "percent": 42, "bytes": 1234,
     "speed": 987654, "etaSeconds": 31}
    {"type": "warning", "jobId": "...", "message": "..."}
    {"type": "done",    "jobId": "...", "path": "...", "size": 1234,
     "warnings": [...]}
    {"type": "error",   "jobId": "...", "code": "...", "message": "..."}

Download engines:

    ffmpeg is the default. For Kinescope streams - multi-period HLS/DASH
    ladders that a bare ffmpeg invocation stitches badly, behind a CDN that
    drops requests with an unexpected Referer - the job is routed through
    N_m3u8DL-RE when that binary is present, with every browser-captured
    header forwarded. The optimized ffmpeg pipeline is the fallback.

    Both engines sit *behind* the DRM gate in handle_download, so neither can
    be used to reach a protected stream. See _assert_no_key_material.

Also usable as an installer:  python3 host.py --install <EXTENSION_ID>

No third-party Python packages are required.
"""

import glob
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HOST_NAME = "com.unrestricted.video.downloader"
HOST_VERSION = "0.4.0"
PROTOCOL_VERSION = 1

# Chrome refuses to send more than 1 MB to a host and will not accept more than
# 1 MB back; anything larger indicates a desynchronised stream.
MAX_MESSAGE_BYTES = 1024 * 1024

# Failure codes shared with src/shared/messages.js. These strings are a
# contract: companion.js maps "drm_protected" to a terminal refusal and treats
# everything else as a generic companion failure, surfacing our message text.
CODE_DRM = "drm_protected"
CODE_CANCELLED = "cancelled"
CODE_FAILED = "companion_failed"
CODE_UNSUPPORTED = "unsupported_codec"
# Matches FailureCode.NETWORK_TIMEOUT. Used when the manifest itself could not
# be read, which is a different diagnosis from "the download failed".
CODE_NETWORK = "network_timeout"

PROGRESS_INTERVAL = 0.5
MANIFEST_FETCH_TIMEOUT = 15
MAX_MANIFEST_BYTES = 8 * 1024 * 1024

# Containers we are willing to write. The filename arrives from the extension
# and is therefore untrusted input.
ALLOWED_EXTENSIONS = (".mp4", ".mkv", ".m4a", ".mp3", ".webm", ".ts")

# Hosts whose streams get the N_m3u8DL-RE treatment.
SEGMENTED_ENGINE_HOSTS = ("kinescope.io",)

# N_m3u8DL-RE ships under a few different casings depending on how it was
# installed; find_binary appends .exe on Windows.
EXTERNAL_DOWNLOADER_CANDIDATES = (
    "N_m3u8DL-RE",
    "n_m3u8dl-re",
    "N_m3u8DL_RE",
    "nm3u8dlre",
)

# Containers N_m3u8DL-RE can mux into. Anything else stays on ffmpeg.
EXTERNAL_MUX_CONTAINERS = {".mp4": "mp4", ".mkv": "mkv"}


# ====================================================================== #
# Logging
#
# stderr is forwarded to Chrome's own log and stdout *is* the wire protocol,
# so neither can be used for diagnostics. Everything goes to a file.
# ====================================================================== #

def _log_path():
    base = os.environ.get("LOCALAPPDATA") if os.name == "nt" else None
    root = Path(base) if base else Path.home()
    directory = root / ("OpenVideoDownloader" if os.name == "nt" else ".openvideo-downloader")
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    return directory / "host.log"


_LOG_FILE = _log_path()
_log_lock = threading.Lock()


def log(message):
    """Append a line to the host log, best effort."""
    if not _LOG_FILE:
        return
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        with _log_lock:
            # Truncate rather than rotate: this is a debug aid, not an audit log.
            if _LOG_FILE.exists() and _LOG_FILE.stat().st_size > 512 * 1024:
                _LOG_FILE.unlink()
            with _LOG_FILE.open("a", encoding="utf-8") as handle:
                handle.write("[{0}] {1}\n".format(stamp, message))
    except OSError:
        pass


# ====================================================================== #
# Framing
# ====================================================================== #

def _use_binary_stdio():
    """
    On Windows the default text mode rewrites 0x0A as 0x0D 0x0A, which would
    corrupt both the length prefix and any payload byte that happens to be a
    newline. Native messaging requires raw binary streams.
    """
    if os.name != "nt":
        return
    try:
        import msvcrt

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    except Exception as exc:  # pragma: no cover - platform specific
        log("could not switch stdio to binary mode: {0}".format(exc))


_write_lock = threading.Lock()


def send_message(payload):
    """Write one length-prefixed JSON message to stdout."""
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_MESSAGE_BYTES:
        data = json.dumps(
            {"type": "error", "code": CODE_FAILED, "message": "Host tried to send an oversized message"},
            separators=(",", ":"),
        ).encode("utf-8")
    with _write_lock:
        try:
            sys.stdout.buffer.write(struct.pack("@I", len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        except (BrokenPipeError, OSError):
            # Chrome closed the port; nothing useful remains to be done.
            raise SystemExit(0)


def read_message():
    """Read one length-prefixed JSON message, or None at end of stream."""
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("@I", header)
    if length == 0 or length > MAX_MESSAGE_BYTES:
        log("refusing implausible message length {0}".format(length))
        return None

    chunks = []
    remaining = length
    while remaining > 0:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)

    try:
        return json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        log("undecodable message: {0}".format(exc))
        return None


# ====================================================================== #
# Environment discovery
# ====================================================================== #

def _extra_binary_dirs():
    if sys.platform == "darwin":
        return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]
    if os.name == "nt":
        program_files = os.environ.get("ProgramFiles", "C:\\Program Files")
        return [
            "C:\\ffmpeg\\bin",
            os.path.join(program_files, "ffmpeg", "bin"),
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Links"),
        ]
    return ["/usr/bin", "/usr/local/bin", "/snap/bin"]


def find_binary(name):
    """
    Locate ffmpeg/ffprobe.

    PATH is checked first, then the usual install locations - a GUI-launched
    Chrome on macOS often has a minimal PATH that excludes Homebrew, so a
    PATH-only lookup reports "not installed" for a working ffmpeg.
    """
    exe = name + ".exe" if os.name == "nt" else name
    found = shutil.which(exe)
    if found:
        return found
    for directory in _extra_binary_dirs():
        if not directory:
            continue
        candidate = Path(directory) / exe
        if candidate.is_file() and os.access(str(candidate), os.X_OK):
            return str(candidate)
    return None


def find_external_downloader():
    """Locate N_m3u8DL-RE, or None. Same PATH-then-known-dirs walk as ffmpeg."""
    for name in EXTERNAL_DOWNLOADER_CANDIDATES:
        found = find_binary(name)
        if found:
            return found
    return None


def _run_quiet(argv, timeout=10):
    """Run a helper process without letting it inherit our stdio."""
    creation = 0
    if os.name == "nt":
        creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        creationflags=creation,
    )


def ffmpeg_info():
    path = find_binary("ffmpeg")
    if not path:
        return {"available": False, "version": None, "path": None}
    version = None
    try:
        result = _run_quiet([path, "-version"])
        first = (result.stdout or b"").decode("utf-8", "replace").splitlines()
        if first:
            match = re.search(r"ffmpeg version (\S+)", first[0])
            version = match.group(1) if match else first[0].strip()
    except (OSError, subprocess.SubprocessError) as exc:
        log("ffmpeg -version failed: {0}".format(exc))
    return {"available": True, "version": version, "path": path}


def external_downloader_info():
    """Capability report for the popup, mirroring ffmpeg_info's shape."""
    path = find_external_downloader()
    if not path:
        return {"available": False, "name": "N_m3u8DL-RE", "version": None, "path": None}
    version = None
    try:
        result = _run_quiet([path, "--version"])
        blob = ((result.stdout or b"") + (result.stderr or b"")).decode("utf-8", "replace")
        for line in blob.splitlines():
            if line.strip():
                version = line.strip()
                break
    except (OSError, subprocess.SubprocessError) as exc:
        log("N_m3u8DL-RE --version failed: {0}".format(exc))
    return {"available": True, "name": "N_m3u8DL-RE", "version": version, "path": path}


def downloads_dir():
    """The user's Downloads folder, per platform convention."""
    if os.name == "nt":
        try:
            import winreg

            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders",
            )
            with key:
                # The Downloads known-folder GUID.
                value, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
            if value:
                expanded = Path(os.path.expandvars(value))
                if expanded.is_dir():
                    return expanded
        except Exception as exc:
            log("could not read Downloads from the registry: {0}".format(exc))
    elif sys.platform.startswith("linux"):
        try:
            result = _run_quiet(["xdg-user-dir", "DOWNLOAD"], timeout=5)
            candidate = (result.stdout or b"").decode("utf-8", "replace").strip()
            if candidate and Path(candidate).is_dir():
                return Path(candidate)
        except (OSError, subprocess.SubprocessError):
            pass

    fallback = Path.home() / "Downloads"
    try:
        fallback.mkdir(parents=True, exist_ok=True)
    except OSError:
        return Path.home()
    return fallback


# ====================================================================== #
# Untrusted input handling
# ====================================================================== #

_BAD_FILENAME_CHARS = re.compile(r'[\x00-\x1f<>:"/\\|?*]+')


def safe_output_path(filename, target_dir):
    """
    Turn the requested filename into a path inside `target_dir`.

    The name arrives over native messaging and is therefore untrusted: any
    allowed origin can talk to this host. Directory separators and traversal
    are stripped rather than escaped, and the extension is forced onto a
    whitelist so this process can only ever write a media file into Downloads.
    """
    name = str(filename or "").strip()
    name = name.replace("..", "_")
    name = _BAD_FILENAME_CHARS.sub("_", name)
    name = os.path.basename(name).strip(". ")

    if not name:
        name = "video.mp4"

    stem, extension = os.path.splitext(name)
    if extension.lower() not in ALLOWED_EXTENSIONS:
        extension = ".mp4"
    stem = stem[:150] or "video"

    candidate = target_dir / (stem + extension)
    index = 1
    while candidate.exists():
        candidate = target_dir / "{0} ({1}){2}".format(stem, index, extension)
        index += 1
        if index > 999:
            break
    return candidate


def sanitise_header(value):
    """Header values are joined with CRLF; a newline inside one would inject
    arbitrary extra headers into ffmpeg's request."""
    return re.sub(r"[\r\n\x00]+", " ", str(value)).strip()


def header_lines(headers):
    lines = []
    for key, value in (headers or {}).items():
        clean_key = re.sub(r"[^A-Za-z0-9\-]", "", str(key))
        clean_value = sanitise_header(value)
        if clean_key and clean_value:
            lines.append("{0}: {1}".format(clean_key, clean_value))
    return lines


def _split_headers(headers):
    """
    Split the payload headers into the two ffmpeg wants as dedicated options
    and the remainder.

    Returns (user_agent, referer, others).
    """
    user_agent = ""
    referer = ""
    others = {}
    for key, value in (headers or {}).items():
        lowered = str(key).strip().lower()
        if lowered == "user-agent":
            user_agent = sanitise_header(value)
        elif lowered == "referer":
            referer = sanitise_header(value)
        else:
            others[key] = value
    return user_agent, referer, others


def _is_segmented_engine_host(url):
    """
    Whether this URL belongs to a platform that needs the segmented engine.

    Matched on the parsed hostname rather than with a substring test: a
    naive `"kinescope.io" in url` would also fire on
    `https://elsewhere.example/?ref=kinescope.io`.
    """
    try:
        host = (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return False
    return any(host == known or host.endswith("." + known) for known in SEGMENTED_ENGINE_HOSTS)


# ====================================================================== #
# DRM refusal
# ====================================================================== #

# Systems that mean "licence server required". Sample-AES is included because
# it is FairPlay's transport form.
_DRM_PATTERNS = (
    ("widevine", re.compile(r"widevine|edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", re.I)),
    ("playready", re.compile(r"playready|9a04f079-9840-4286-ab92-e65be0885f95", re.I)),
    ("fairplay", re.compile(r"com\.apple\.streamingkeydelivery|skd://|94ce86fb-07ff-4f43-adb8-93d2fa968ca2", re.I)),
    ("sample-aes", re.compile(r"METHOD=SAMPLE-AES", re.I)),
    ("cenc", re.compile(r"<cenc:pssh|ContentProtection[^>]+cenc", re.I)),
)


def fetch_manifest(url, headers):
    """
    Fetch a manifest for inspection.

    Returns (text, error). `text` is None whenever the body could not be read,
    and `error` then describes why.

    The two-value return exists because the DRM gate is only meaningful if it
    actually sees the manifest. Returning a bare None conflated "unreadable"
    with "empty", and detect_drm(None) reports no protection - so the caller
    must be able to tell the difference. See handle_download.
    """
    request = urllib.request.Request(url)
    for line in header_lines(headers):
        key, _, value = line.partition(": ")
        request.add_header(key, value)

    try:
        with urllib.request.urlopen(request, timeout=MANIFEST_FETCH_TIMEOUT) as response:
            raw = response.read(MAX_MANIFEST_BYTES)
    except urllib.error.HTTPError as exc:
        # 401/403 here is the signature of referer-gated hotlink protection,
        # which is standard on Kinescope and worth naming in the message.
        detail = "HTTP {0} {1}".format(exc.code, exc.reason or "").strip()
        log("manifest fetch failed: {0}".format(detail))
        return None, detail
    except urllib.error.URLError as exc:
        detail = "network error: {0}".format(exc.reason)
        log("manifest fetch failed: {0}".format(detail))
        return None, detail
    except (OSError, ValueError) as exc:
        detail = "{0}: {1}".format(type(exc).__name__, exc)
        log("manifest fetch failed: {0}".format(detail))
        return None, detail

    text = raw.decode("utf-8", "replace")
    if not text.strip():
        # A 200 with an empty body would otherwise re-open the same fail-open
        # hole: nothing to match against reads as "no DRM".
        log("manifest fetch returned an empty body")
        return None, "the server returned an empty manifest"

    return text, None


def detect_drm(manifest_text):
    """
    Return the DRM scheme name, or None.

    Deliberately does *not* treat METHOD=AES-128 as DRM. Plain AES-128 is
    ordinary HLS transport encryption with the key served next to the playlist;
    ffmpeg handles it natively and Strategy A decrypts it in-browser. Refusing
    it would break a large share of perfectly normal streams, while letting
    Sample-AES through would turn this host into a DRM bypass.

    Note that a falsy `manifest_text` yields None, which is indistinguishable
    from a clean manifest. Callers must reject an unreadable manifest *before*
    reaching this function rather than relying on its return value.
    """
    if not manifest_text:
        return None
    for name, pattern in _DRM_PATTERNS:
        if pattern.search(manifest_text):
            return name
    return None


# Flags that hand an external downloader the means to decrypt a protected
# stream. The DRM gate in handle_download already refuses Widevine, PlayReady,
# FairPlay, Sample-AES and CENC before any engine is chosen, so none of these
# should ever be constructed. This list makes that a checked invariant instead
# of an assumption: N_m3u8DL-RE is perfectly capable of DRM decryption when
# given key material, and this host must never be the thing that supplies it.
_KEY_MATERIAL_FLAGS = frozenset(
    {
        "--key",
        "--key-text-file",
        "--custom-hls-key",
        "--custom-hls-iv",
        "--custom-hls-method",
        "--mp4-real-time-decryption",
        "--use-shaka-packager",
        "--decryption-binary-path",
        "--decryption-engine",
    }
)


def _assert_no_key_material(argv):
    """Refuse to launch an external engine configured to decrypt DRM."""
    for token in argv:
        base = str(token).strip().lower().split("=", 1)[0]
        if base in _KEY_MATERIAL_FLAGS:
            raise ValueError(
                "refusing to pass decryption key material to the external downloader ({0})".format(base)
            )


# ====================================================================== #
# Stream selection
# ====================================================================== #

def probe_streams(manifest_url, headers, ffprobe_path):
    """Enumerate programs and streams with ffprobe. Returns None on failure."""
    if not ffprobe_path:
        return None

    argv = [ffprobe_path, "-hide_banner", "-v", "quiet"]
    lines = header_lines(headers)
    if lines:
        argv += ["-headers", "\r\n".join(lines) + "\r\n"]
    argv += ["-print_format", "json", "-show_programs", "-show_streams", "-i", manifest_url]

    try:
        result = _run_quiet(argv, timeout=45)
        if result.returncode != 0:
            log("ffprobe exited {0}".format(result.returncode))
            return None
        return json.loads((result.stdout or b"{}").decode("utf-8", "replace"))
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        log("ffprobe failed: {0}".format(exc))
        return None


def choose_map_args(probe, requested_height):
    """
    Decide which streams ffmpeg should copy.

    An HLS master playlist is exposed by ffmpeg as one program per variant. Without
    an explicit -map, ffmpeg applies its own default selection and the user
    silently gets a rendition they did not pick, so pinning the program is the
    only way to honour the request.

    Returns (map_args, warnings, chosen_height).
    """
    warnings = []
    if not probe:
        return [], ["ffprobe was unavailable, so ffmpeg chose the rendition automatically"], None

    programs = [p for p in (probe.get("programs") or []) if p.get("streams")]

    def video_height(streams):
        for stream in streams:
            if stream.get("codec_type") == "video" and stream.get("height"):
                return int(stream["height"])
        return None

    if programs:
        scored = []
        for program in programs:
            height = video_height(program.get("streams") or [])
            if height:
                scored.append((height, program))
        if scored:
            if requested_height:
                # Exact match, else the closest rendition.
                scored.sort(key=lambda item: (abs(item[0] - requested_height), -item[0]))
            else:
                scored.sort(key=lambda item: -item[0])
            height, program = scored[0]
            program_id = program.get("program_id")
            if program_id is not None:
                if requested_height and height != requested_height:
                    warnings.append(
                        "Requested {0}p was not offered; downloaded {1}p instead".format(requested_height, height)
                    )
                # -dn -sn drop data and subtitle streams, which cannot always be
                # copied into MP4 and would fail the whole mux.
                return ["-map", "0:p:{0}".format(program_id), "-dn", "-sn"], warnings, height

    # No program structure (typical for DASH): pick streams directly.
    streams = probe.get("streams") or []
    videos = [s for s in streams if s.get("codec_type") == "video" and s.get("height")]
    audios = [s for s in streams if s.get("codec_type") == "audio"]

    if not videos and not audios:
        return [], ["No audio or video streams were reported; letting ffmpeg decide"], None

    args = []
    chosen = None
    if videos:
        if requested_height:
            videos.sort(key=lambda s: (abs(int(s["height"]) - requested_height), -int(s["height"])))
        else:
            videos.sort(key=lambda s: -int(s["height"]))
        best = videos[0]
        chosen = int(best["height"])
        if requested_height and chosen != requested_height:
            warnings.append(
                "Requested {0}p was not offered; downloaded {1}p instead".format(requested_height, chosen)
            )
        args += ["-map", "0:{0}".format(best.get("index", 0))]

    if audios:
        audios.sort(key=lambda s: -int(s.get("bit_rate") or s.get("channels") or 0))
        args += ["-map", "0:{0}".format(audios[0].get("index", 0))]

    return args + ["-dn", "-sn"], warnings, chosen


def probe_duration(probe, fallback):
    """Total duration in seconds, needed to turn ffmpeg's clock into a percentage."""
    if probe:
        for stream in probe.get("streams") or []:
            try:
                value = float(stream.get("duration") or 0)
            except (TypeError, ValueError):
                value = 0.0
            if value > 0:
                return value
    try:
        value = float(fallback or 0)
        return value if value > 0 else None
    except (TypeError, ValueError):
        return None


# ====================================================================== #
# Job execution
# ====================================================================== #

class Job(object):
    """One download. Owns the engine process and the cancellation flag."""

    def __init__(self, job_id, streaming):
        self.job_id = job_id
        self.streaming = streaming
        self.cancelled = threading.Event()
        self.process = None
        self.warnings = []

    def emit(self, payload):
        """
        Send an intermediate message - but only when the transport can carry
        one. Under sendNativeMessage Chrome resolves on the first message and
        then tears the process down, so a progress update would abort the
        download it was reporting on.
        """
        if not self.streaming:
            return
        payload["jobId"] = self.job_id
        send_message(payload)

    def warn(self, message):
        if not message:
            return
        self.warnings.append(message)
        log("warning: {0}".format(message))
        self.emit({"type": "warning", "message": message})

    def cancel(self):
        self.cancelled.set()
        process = self.process
        if process and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass


def build_ffmpeg_command(
    ffmpeg_path, manifest_url, headers, map_args, output_path, reencode_audio, optimized=False
):
    """
    Assemble the ffmpeg invocation.

    `optimized` turns on the segment-heavy tuning wanted for platforms like
    Kinescope. It is a separate attempt rather than the default because a few
    of those options are relatively recent, and an ffmpeg that does not know an
    option aborts instead of ignoring it - see the attempt ladder in
    handle_download.
    """
    argv = [ffmpeg_path, "-hide_banner", "-nostdin", "-y", "-loglevel", "warning"]

    # Input options must precede -i, or they are silently ignored.
    user_agent, referer, other = _split_headers(headers)
    if user_agent:
        argv += ["-user_agent", user_agent]

    if referer:
        if optimized:
            # A dedicated -referer is applied per-request by the http protocol,
            # whereas a Referer smuggled through -headers is dropped by some
            # builds when a segment redirects - which is exactly when a
            # hotlink check runs.
            argv += ["-referer", referer]
        else:
            other = dict(other)
            other["Referer"] = referer

    lines = header_lines(other)
    if lines:
        argv += ["-headers", "\r\n".join(lines) + "\r\n"]

    argv += [
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-rw_timeout", "20000000",
        "-allowed_extensions", "ALL",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto,httpproxy",
    ]

    if optimized:
        argv += [
            # Retry the transient refusals a busy segment CDN hands out, rather
            # than tearing down the whole job on one bad chunk.
            "-reconnect_on_network_error", "1",
            "-reconnect_on_http_error", "403,404,408,429,500,502,503,504",
            # Reuse the connection across segments; a fresh TLS handshake per
            # chunk is what makes long ladders crawl and time out.
            "-multiple_requests", "1",
            "-max_reload", "16",
            # Multi-period HLS/DASH restarts its timestamps at each period, so
            # regenerate them instead of writing a file that seeks wrongly.
            "-fflags", "+genpts",
        ]

    argv += ["-i", manifest_url]

    argv += map_args

    if reencode_audio:
        argv += ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]
    else:
        # aac_adtstoasc is required for AAC inside MPEG-TS (the HLS case) and is
        # a no-op elsewhere; ffmpeg errors if the audio is not AAC, which the
        # re-encode retry then handles.
        argv += ["-c", "copy", "-bsf:a", "aac_adtstoasc"]

    if optimized:
        argv += [
            "-avoid_negative_ts", "make_zero",
            "-max_muxing_queue_size", "4096",
        ]

    argv += [
        "-movflags", "+faststart",
        "-progress", "pipe:2",
        "-nostats",
        str(output_path),
    ]
    return argv


def build_external_command(
    binary, manifest_url, headers, output_path, tmp_dir, requested_height, ffmpeg_path
):
    """
    Assemble the N_m3u8DL-RE invocation.

    Every header the browser captured is forwarded verbatim with -H, including
    User-Agent, Referer, Origin and Cookie. That is the whole point of the
    detour: the session that was authorised to watch the stream is the session
    that has to fetch the segments, or the CDN answers 403.

    No decryption options are ever added. _assert_no_key_material enforces it.
    """
    argv = [binary, manifest_url]

    for line in header_lines(headers):
        argv += ["-H", line]

    if requested_height:
        # for=best breaks ties within the requested height rather than picking
        # an arbitrary rendition.
        argv += ["-sv", "res={0}*:for=best".format(requested_height), "-sa", "best"]
    else:
        argv += ["--auto-select"]

    container = EXTERNAL_MUX_CONTAINERS.get(output_path.suffix.lower(), "mp4")
    mux = "format={0}:muxer=ffmpeg:skip_sub=true".format(container)
    if ffmpeg_path:
        mux += ":bin_path={0}".format(ffmpeg_path)
    argv += ["-M", mux]

    if ffmpeg_path:
        argv += ["--ffmpeg-binary-path", ffmpeg_path]

    argv += [
        "--save-dir", str(output_path.parent),
        "--save-name", output_path.stem,
        "--tmp-dir", str(tmp_dir),
        "--thread-count", "8",
        "--download-retry-count", "5",
        "--http-request-timeout", "30",
        "--del-after-done",
        # Our stdout is the native messaging wire; keep the child's output
        # plain so it can be parsed, and keep it from writing its own log file.
        "--no-ansi-color",
        "--no-log",
    ]
    return argv


def run_ffmpeg(job, argv, duration, output_path):
    """
    Run ffmpeg and relay progress.

    ffmpeg's stdout is discarded: this process's stdout is the native messaging
    channel and a single byte of ffmpeg output on it would desync the framing.
    Progress is therefore requested on stderr with -progress pipe:2.
    """
    creation = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    log("running: {0}".format(" ".join(argv[:6]) + " ... " + str(output_path)))

    job.process = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=creation,
    )

    last_emit = 0.0
    last_bytes = 0
    last_time = time.time()
    total_bytes = 0
    out_seconds = 0.0
    speed = 0.0
    tail = []

    for raw in iter(job.process.stderr.readline, b""):
        if job.cancelled.is_set():
            break

        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue

        if "=" in line and not line.startswith("["):
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()

            if key == "total_size" and value.isdigit():
                total_bytes = int(value)
            elif key == "out_time_us" and value.lstrip("-").isdigit():
                out_seconds = max(0.0, int(value) / 1_000_000.0)
            elif key == "out_time_ms" and value.lstrip("-").isdigit():
                # Misleadingly named: ffmpeg reports microseconds here too.
                out_seconds = max(0.0, int(value) / 1_000_000.0)
            elif key == "progress" and value == "end":
                break
            else:
                continue

            now = time.time()
            if now - last_emit < PROGRESS_INTERVAL:
                continue

            elapsed = now - last_time
            if elapsed > 0 and total_bytes >= last_bytes:
                # ffmpeg's own "speed=" is a playback multiplier, not a
                # transfer rate, so derive bytes/second here.
                speed = (total_bytes - last_bytes) / elapsed
            last_bytes = total_bytes
            last_time = now
            last_emit = now

            percent = None
            eta = None
            if duration and duration > 0:
                percent = max(0, min(99, int(out_seconds / duration * 100)))
                remaining = duration - out_seconds
                if remaining > 0 and out_seconds > 0:
                    rate = out_seconds / max(0.001, now - _job_started_at)
                    if rate > 0:
                        eta = int(remaining / rate)

            job.emit(
                {
                    "type": "progress",
                    "percent": percent if percent is not None else 0,
                    "bytes": total_bytes,
                    "speed": int(max(0.0, speed)),
                    "etaSeconds": eta,
                    "seconds": round(out_seconds, 2),
                }
            )
        else:
            # Keep the last few real log lines to explain a non-zero exit.
            tail.append(line)
            del tail[:-12]

    try:
        job.process.stderr.close()
    except OSError:
        pass

    if job.cancelled.is_set():
        try:
            job.process.terminate()
            job.process.wait(timeout=10)
        except (OSError, subprocess.SubprocessError):
            pass
        return -1, tail, total_bytes

    try:
        returncode = job.process.wait(timeout=60)
    except subprocess.TimeoutExpired:
        job.process.kill()
        returncode = -1

    return returncode, tail, total_bytes


_EXTERNAL_PERCENT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")
_EXTERNAL_SPEED_RE = re.compile(r"(\d+(?:\.\d+)?)\s*([KMG]?)Bps", re.I)
_SPEED_UNITS = {"": 1, "K": 1024, "M": 1024 * 1024, "G": 1024 * 1024 * 1024}


def run_external_downloader(job, argv, output_path):
    """
    Run N_m3u8DL-RE and relay progress.

    Its progress is drawn on stdout and redrawn with carriage returns, so
    stderr is folded in and the whole stream is split on both terminators. The
    child's stdout is piped rather than inherited for the same reason ffmpeg's
    is discarded: our own stdout is the native messaging channel.

    Returns (returncode, tail).
    """
    creation = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    log("running external engine: {0} ... {1}".format(argv[0], output_path))

    job.process = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        creationflags=creation,
    )

    last_emit = 0.0
    percent = 0
    speed = 0
    tail = []
    buffer = b""
    stream = job.process.stdout

    while True:
        if job.cancelled.is_set():
            break
        try:
            chunk = stream.read1(4096) if hasattr(stream, "read1") else stream.read(4096)
        except (OSError, ValueError):
            break
        if not chunk:
            break

        buffer += chunk.replace(b"\r", b"\n")
        # A child that never emits a terminator must not grow this unboundedly.
        if len(buffer) > 65536:
            buffer = buffer[-4096:]

        while b"\n" in buffer:
            raw, _, buffer = buffer.partition(b"\n")
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue

            matches = _EXTERNAL_PERCENT_RE.findall(line)
            if not matches:
                # Keep the last few real log lines to explain a non-zero exit.
                tail.append(line)
                del tail[:-12]
                continue

            try:
                percent = max(0, min(99, int(float(matches[-1]))))
            except (TypeError, ValueError):
                pass

            speed_match = _EXTERNAL_SPEED_RE.search(line)
            if speed_match:
                try:
                    unit = _SPEED_UNITS.get(speed_match.group(2).upper(), 1)
                    speed = int(float(speed_match.group(1)) * unit)
                except (TypeError, ValueError):
                    speed = 0

            now = time.time()
            if now - last_emit >= PROGRESS_INTERVAL:
                last_emit = now
                job.emit(
                    {
                        "type": "progress",
                        "percent": percent,
                        "speed": speed,
                        "etaSeconds": None,
                    }
                )

    try:
        stream.close()
    except OSError:
        pass

    if job.cancelled.is_set():
        try:
            job.process.terminate()
            job.process.wait(timeout=10)
        except (OSError, subprocess.SubprocessError):
            pass
        return -1, tail

    try:
        returncode = job.process.wait(timeout=120)
    except subprocess.TimeoutExpired:
        job.process.kill()
        returncode = -1

    return returncode, tail


def locate_external_output(output_path):
    """
    Find what the external engine actually wrote.

    It is given --save-name without an extension and picks the container
    itself, so the result may not land exactly on `output_path`. Anything it
    did produce is moved onto the path already promised to the extension.
    """
    if output_path.exists():
        return output_path

    pattern = glob.escape(output_path.stem) + ".*"
    candidates = [
        path
        for path in output_path.parent.glob(pattern)
        if path.is_file() and path.suffix.lower() in ALLOWED_EXTENSIONS
    ]
    if not candidates:
        return None

    try:
        candidates.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    except OSError:
        pass

    produced = candidates[0]
    if produced == output_path:
        return produced
    try:
        produced.replace(output_path)
        return output_path
    except OSError as exc:
        log("could not normalise external output name: {0}".format(exc))
        return produced


_job_started_at = time.time()


def handle_download(request, streaming):
    """Execute a download request and return the terminal message."""
    global _job_started_at

    job_id = str(request.get("jobId") or "job")
    job = Job(job_id, streaming)
    _ACTIVE_JOBS[job_id] = job

    try:
        if int(request.get("protocol") or 0) != PROTOCOL_VERSION:
            return {
                "type": "error",
                "jobId": job_id,
                "code": CODE_FAILED,
                "message": "Protocol mismatch: host speaks v{0}. Re-run the installer.".format(PROTOCOL_VERSION),
            }

        manifest_url = str(request.get("manifestUrl") or "")
        if not manifest_url.lower().startswith(("http://", "https://")):
            return {
                "type": "error",
                "jobId": job_id,
                "code": CODE_FAILED,
                "message": "Refusing a non-HTTP manifest URL",
            }

        info = ffmpeg_info()
        if not info["available"]:
            return {
                "type": "error",
                "jobId": job_id,
                "code": CODE_FAILED,
                "message": "ffmpeg was not found on PATH. Install it and retry.",
            }

        headers = request.get("headers") or {}

        # Independent DRM refusal. The extension already blocks protected
        # streams, but a native host reachable by any allowed origin must not
        # rely on its caller to enforce that.
        #
        # The gate is fail-closed. detect_drm returns None both for "inspected
        # and clean" and for "nothing to inspect", so a manifest we could not
        # read has to abort the job here. Previously a network timeout, a 403
        # from referer-gated hotlink protection, or an empty body would wave a
        # protected stream straight through this check and then fail obscurely
        # somewhere inside ffmpeg.
        manifest_text, fetch_error = fetch_manifest(manifest_url, headers)
        if manifest_text is None:
            log("rejecting {0}: manifest unreadable ({1})".format(manifest_url, fetch_error))
            return {
                "type": "error",
                "jobId": job_id,
                "code": CODE_NETWORK,
                "message": (
                    "Could not read the stream manifest ({0}), so the DRM check could not run. "
                    "The link may have expired, or the server may only serve it to the original page."
                ).format(fetch_error),
            }

        scheme = detect_drm(manifest_text)
        if scheme:
            log("refusing {0}: {1} protection detected".format(manifest_url, scheme))
            return {
                "type": "error",
                "jobId": job_id,
                "code": CODE_DRM,
                "message": "This stream is {0}-protected. The companion host does not circumvent DRM.".format(scheme),
            }

        if job.cancelled.is_set():
            return {"type": "error", "jobId": job_id, "code": CODE_CANCELLED, "message": "Cancelled"}

        target_dir = downloads_dir()
        output_path = safe_output_path(request.get("filename"), target_dir)

        quality = request.get("quality") or {}
        try:
            requested_height = int(quality.get("height") or 0) or None
        except (TypeError, ValueError):
            requested_height = None

        probe = probe_streams(manifest_url, headers, find_binary("ffprobe"))
        map_args, map_warnings, _ = choose_map_args(probe, requested_height)
        for message in map_warnings:
            job.warn(message)

        duration = probe_duration(probe, request.get("duration"))
        if not duration:
            job.warn("Stream duration is unknown, so progress cannot be shown as a percentage")

        _job_started_at = time.time()

        # ------------------------------------------------------------------ #
        # Engine selection
        #
        # Reached only after the DRM gate above, so the external engine is
        # never handed a protected stream. Kinescope's multi-period ladders
        # stitch badly under a bare ffmpeg call; N_m3u8DL-RE downloads each
        # period separately and muxes once, which is what keeps the chunks
        # from corrupting.
        # ------------------------------------------------------------------ #
        segmented_host = _is_segmented_engine_host(manifest_url)
        external_binary = find_external_downloader() if segmented_host else None
        muxable = output_path.suffix.lower() in EXTERNAL_MUX_CONTAINERS

        completed_externally = False
        returncode = -1
        tail = []
        total_bytes = 0

        if segmented_host and external_binary and muxable:
            job.warn(
                "Kinescope stream detected; downloading with N_m3u8DL-RE for reliable "
                "multi-period stitching"
            )
            tmp_dir = Path(tempfile.mkdtemp(prefix="openvideo-"))
            try:
                argv = build_external_command(
                    external_binary,
                    manifest_url,
                    headers,
                    output_path,
                    tmp_dir,
                    requested_height,
                    info["path"],
                )
                # Checked invariant, not an assumption: this host never supplies
                # decryption keys to an external engine.
                _assert_no_key_material(argv)
                returncode, tail = run_external_downloader(job, argv, output_path)
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                log("external engine could not run: {0!r}".format(exc))
                returncode = -1
                tail = [str(exc)]
            finally:
                shutil.rmtree(str(tmp_dir), ignore_errors=True)

            if job.cancelled.is_set():
                _remove_partial(output_path)
                return {"type": "error", "jobId": job_id, "code": CODE_CANCELLED, "message": "Cancelled"}

            if returncode == 0:
                produced = locate_external_output(output_path)
                if produced is not None:
                    output_path = produced
                    completed_externally = True
                else:
                    job.warn(
                        "N_m3u8DL-RE reported success but wrote no file; retrying with ffmpeg"
                    )
            else:
                job.warn(
                    "N_m3u8DL-RE exited {0}; retrying with the optimized ffmpeg pipeline".format(returncode)
                )
        elif segmented_host and not external_binary:
            log("N_m3u8DL-RE not installed; using the optimized ffmpeg pipeline")

        if not completed_externally:
            # (reencode_audio, optimized). The optimized pass leads for a
            # segmented host, then plain stream copy, then an audio re-encode:
            # aac_adtstoasc is mandatory for AAC-in-TS but fatal for other
            # codecs, and an older ffmpeg aborts on an option it does not know
            # rather than ignoring it, so both need a rung below them.
            if segmented_host:
                attempts = ((False, True), (False, False), (True, False))
            else:
                attempts = ((False, False), (True, False))

            for index, (reencode, optimized) in enumerate(attempts):
                if job.cancelled.is_set():
                    break
                argv = build_ffmpeg_command(
                    info["path"], manifest_url, headers, map_args, output_path, reencode, optimized
                )
                returncode, tail, total_bytes = run_ffmpeg(job, argv, duration, output_path)
                if returncode == 0 or job.cancelled.is_set():
                    if reencode:
                        job.warn("Audio was re-encoded to AAC because it could not be copied")
                    break
                log(
                    "ffmpeg attempt {0} failed ({1}); {2}".format(
                        index + 1,
                        returncode,
                        "retrying" if index + 1 < len(attempts) else "giving up",
                    )
                )

        if job.cancelled.is_set():
            _remove_partial(output_path)
            return {"type": "error", "jobId": job_id, "code": CODE_CANCELLED, "message": "Cancelled"}

        if not completed_externally and returncode != 0:
            _remove_partial(output_path)
            detail = " | ".join(tail[-3:]) if tail else "ffmpeg exited {0}".format(returncode)
            code = CODE_UNSUPPORTED if "codec" in detail.lower() else CODE_FAILED
            return {"type": "error", "jobId": job_id, "code": code, "message": detail[:600]}

        size = None
        try:
            size = output_path.stat().st_size
        except OSError:
            size = total_bytes or None

        if not size:
            _remove_partial(output_path)
            return {
                "type": "error",
                "jobId": job_id,
                "code": CODE_FAILED,
                "message": "The download engine reported success but produced an empty file",
            }

        log("completed {0} ({1} bytes)".format(output_path, size))
        return {
            "type": "done",
            "ok": True,
            "jobId": job_id,
            "path": str(output_path),
            "size": int(size),
            "warnings": job.warnings,
        }

    except Exception as exc:  # pragma: no cover - last-resort guard
        log("unhandled error: {0!r}".format(exc))
        return {
            "type": "error",
            "jobId": job_id,
            "code": CODE_FAILED,
            "message": "Host error: {0}".format(exc),
        }
    finally:
        _ACTIVE_JOBS.pop(job_id, None)


def _remove_partial(path):
    """A half-written MP4 is worse than no file: it looks playable and is not."""
    try:
        if path and Path(path).exists():
            Path(path).unlink()
    except OSError as exc:
        log("could not remove partial file: {0}".format(exc))


# ====================================================================== #
# Message loop
# ====================================================================== #

_ACTIVE_JOBS = {}


def _reader_thread(inbox):
    """
    Drain stdin on a separate thread.

    The main thread blocks reading the engine's output, so a cancel that
    arrived inline would not be seen until the download had already finished.
    """
    while True:
        try:
            message = read_message()
        except Exception as exc:
            log("reader stopped: {0!r}".format(exc))
            message = None
        if message is None:
            inbox.append(None)
            break
        action = str(message.get("action") or "")
        if action == "cancel":
            job = _ACTIVE_JOBS.get(str(message.get("jobId") or ""))
            if job:
                log("cancel requested for {0}".format(job.job_id))
                job.cancel()
            else:
                for job in list(_ACTIVE_JOBS.values()):
                    job.cancel()
        else:
            inbox.append(message)


def serve():
    _use_binary_stdio()
    log("host {0} starting (python {1}, {2})".format(HOST_VERSION, sys.version.split()[0], sys.platform))

    first = read_message()
    if first is None:
        return

    inbox = []
    thread = threading.Thread(target=_reader_thread, args=(inbox,),