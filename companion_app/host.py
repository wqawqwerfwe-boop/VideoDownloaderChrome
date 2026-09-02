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

Also usable as an installer:  python3 host.py --install <EXTENSION_ID>

No third-party Python packages are required.
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HOST_NAME = "com.unrestricted.video.downloader"
HOST_VERSION = "0.3.0"
PROTOCOL_VERSION = 1

# Chrome refuses to send more than 1 MB to a host and will not accept more than
# 1 MB back; anything larger indicates a desynchronised stream.
MAX_MESSAGE_BYTES = 1024 * 1024

# Failure codes shared with src/shared/messages.js. These strings are a
# contract: companion.js maps "drm_protected" to a terminal refusal and treats
# everything else as a generic companion failure.
CODE_DRM = "drm_protected"
CODE_CANCELLED = "cancelled"
CODE_FAILED = "companion_failed"
CODE_UNSUPPORTED = "unsupported_codec"

PROGRESS_INTERVAL = 0.5
MANIFEST_FETCH_TIMEOUT = 15
MAX_MANIFEST_BYTES = 8 * 1024 * 1024

# Containers we are willing to write. The filename arrives from the extension
# and is therefore untrusted input.
ALLOWED_EXTENSIONS = (".mp4", ".mkv", ".m4a", ".mp3", ".webm", ".ts")


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
    """Fetch a manifest for inspection. Returns text, or None if unreadable."""
    request = urllib.request.Request(url)
    for line in header_lines(headers):
        key, _, value = line.partition(": ")
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=MANIFEST_FETCH_TIMEOUT) as response:
            return response.read(MAX_MANIFEST_BYTES).decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        log("manifest fetch failed: {0}".format(exc))
        return None


def detect_drm(manifest_text):
    """
    Return the DRM scheme name, or None.

    Deliberately does *not* treat METHOD=AES-128 as DRM. Plain AES-128 is
    ordinary HLS transport encryption with the key served next to the playlist;
    ffmpeg handles it natively and Strategy A decrypts it in-browser. Refusing
    it would break a large share of perfectly normal streams, while letting
    Sample-AES through would turn this host into a DRM bypass.
    """
    if not manifest_text:
        return None
    for name, pattern in _DRM_PATTERNS:
        if pattern.search(manifest_text):
            return name
    return None


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
    """One download. Owns the ffmpeg process and the cancellation flag."""

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


def build_ffmpeg_command(ffmpeg_path, manifest_url, headers, map_args, output_path, reencode_audio):
    argv = [ffmpeg_path, "-hide_banner", "-nostdin", "-y", "-loglevel", "warning"]

    # Input options must precede -i, or they are silently ignored.
    user_agent = sanitise_header((headers or {}).get("User-Agent") or "")
    if user_agent:
        argv += ["-user_agent", user_agent]

    other = {k: v for k, v in (headers or {}).items() if k.lower() != "user-agent"}
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
        "-i", manifest_url,
    ]

    argv += map_args

    if reencode_audio:
        argv += ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]
    else:
        # aac_adtstoasc is required for AAC inside MPEG-TS (the HLS case) and is
        # a no-op elsewhere; ffmpeg errors if the audio is not AAC, which the
        # re-encode retry then handles.
        argv += ["-c", "copy", "-bsf:a", "aac_adtstoasc"]

    argv += [
        "-movflags", "+faststart",
        "-progress", "pipe:2",
        "-nostats",
        str(output_path),
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
        manifest_text = fetch_manifest(manifest_url, headers)
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

        # Attempt a pure stream copy first; retry once re-encoding audio, since
        # aac_adtstoasc is mandatory for AAC-in-TS but fatal for other codecs.
        attempts = (False, True)
        returncode = -1
        tail = []
        total_bytes = 0

        for index, reencode in enumerate(attempts):
            if job.cancelled.is_set():
                break
            argv = build_ffmpeg_command(
                info["path"], manifest_url, headers, map_args, output_path, reencode
            )
            returncode, tail, total_bytes = run_ffmpeg(job, argv, duration, output_path)
            if returncode == 0 or job.cancelled.is_set():
                if reencode:
                    job.warn("Audio was re-encoded to AAC because it could not be copied")
                break
            if index == 0:
                log("stream copy failed ({0}); retrying with an audio re-encode".format(returncode))

        if job.cancelled.is_set():
            _remove_partial(output_path)
            return {"type": "error", "jobId": job_id, "code": CODE_CANCELLED, "message": "Cancelled"}

        if returncode != 0:
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
                "message": "ffmpeg reported success but produced an empty file",
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

    The main thread blocks reading ffmpeg's stderr, so a cancel that arrived
    inline would not be seen until the download had already finished.
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
    thread = threading.Thread(target=_reader_thread, args=(inbox,), daemon=True)
    thread.start()

    message = first
    while message is not None:
        action = str(message.get("action") or "")

        # `stream` tells the host which transport is in use. connectNative can
        # carry many messages; sendNativeMessage accepts exactly one and kills
        # the process afterwards. Default to streaming for older clients.
        streaming = message.get("stream") is not False

        if action == "ping":
            info = ffmpeg_info()
            send_message(
                {
                    "ok": True,
                    "version": HOST_VERSION,
                    "protocol": PROTOCOL_VERSION,
                    "ffmpeg": info,
                    "ffprobe": {"available": bool(find_binary("ffprobe"))},
                    "downloadsDir": str(downloads_dir()),
                    "platform": sys.platform,
                }
            )

        elif action == "download":
            send_message(handle_download(message, streaming))

        elif action == "cancel":
            job = _ACTIVE_JOBS.get(str(message.get("jobId") or ""))
            if job:
                job.cancel()
            send_message({"type": "error", "code": CODE_CANCELLED, "message": "Cancelled"})

        else:
            send_message(
                {
                    "type": "error",
                    "code": CODE_FAILED,
                    "message": "Unknown action: {0}".format(action or "(none)"),
                }
            )

        # One-shot callers get exactly one reply and then close the pipe.
        if not streaming:
            break

        while not inbox:
            time.sleep(0.05)
            if not thread.is_alive() and not inbox:
                return
        message = inbox.pop(0)

    log("host exiting")


# ====================================================================== #
# Installer
#
# Lives here so install.sh and install.bat stay thin. Batch and shell both make
# a mess of JSON quoting, and the manifest path must be absolute and exact.
# ====================================================================== #

def _browser_manifest_dirs():
    home = Path.home()
    if sys.platform == "darwin":
        support = home / "Library" / "Application Support"
        return [
            support / "Google" / "Chrome" / "NativeMessagingHosts",
            support / "Google" / "Chrome Beta" / "NativeMessagingHosts",
            support / "Chromium" / "NativeMessagingHosts",
            support / "Microsoft Edge" / "NativeMessagingHosts",
            support / "BraveSoftware" / "Brave-Browser" / "NativeMessagingHosts",
            support / "Vivaldi" / "NativeMessagingHosts",
        ]
    if os.name == "nt":
        return []  # Windows uses the registry instead.
    config = Path(os.environ.get("XDG_CONFIG_HOME") or (home / ".config"))
    return [
        config / "google-chrome" / "NativeMessagingHosts",
        config / "google-chrome-beta" / "NativeMessagingHosts",
        config / "chromium" / "NativeMessagingHosts",
        config / "microsoft-edge" / "NativeMessagingHosts",
        config / "BraveSoftware" / "Brave-Browser" / "NativeMessagingHosts",
        config / "vivaldi" / "NativeMessagingHosts",
    ]


def _windows_launcher(script_path):
    """
    Windows native messaging will not execute a .py file directly, so point the
    manifest at a .bat shim that invokes the interpreter.
    """
    launcher = script_path.parent / "host.bat"
    launcher.write_text(
        "@echo off\r\n" '"{0}" "{1}" %*\r\n'.format(sys.executable, script_path),
        encoding="utf-8",
    )
    return launcher


def install(extension_ids):
    script_path = Path(__file__).resolve()

    if not extension_ids:
        print("Usage: python3 host.py --install <EXTENSION_ID> [MORE_IDS...]")
        print()
        print("Find the ID on chrome://extensions with Developer mode enabled.")
        print("An unpacked extension gets a fresh random ID unless manifest.json")
        print('pins one with a "key" field, so re-run this after reloading it.')
        return 2

    clean_ids = []
    for value in extension_ids:
        candidate = str(value).strip().strip("/").replace("chrome-extension://", "")
        if re.fullmatch(r"[a-p]{32}", candidate):
            clean_ids.append(candidate)
        else:
            print("Ignoring implausible extension ID: {0}".format(candidate))

    if not clean_ids:
        print("No valid extension IDs were given. An ID is 32 letters, a-p.")
        return 2

    if os.name == "nt":
        target = _windows_launcher(script_path)
    else:
        target = script_path
        try:
            mode = os.stat(str(script_path)).st_mode
            os.chmod(str(script_path), mode | 0o111)
        except OSError as exc:
            print("Warning: could not mark host.py executable ({0})".format(exc))

    manifest = {
        "name": HOST_NAME,
        "description": "OpenVideo Downloader companion host (ffmpeg bridge)",
        "path": str(target),
        "type": "stdio",
        "allowed_origins": ["chrome-extension://{0}/".format(i) for i in clean_ids],
    }
    blob = json.dumps(manifest, indent=2) + "\n"

    written = []

    if os.name == "nt":
        import winreg

        manifest_dir = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "OpenVideoDownloader"
        manifest_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = manifest_dir / (HOST_NAME + ".json")
        manifest_path.write_text(blob, encoding="utf-8")
        written.append(manifest_path)

        # Per-user keys need no administrator rights.
        for vendor in (
            r"Software\Google\Chrome\NativeMessagingHosts",
            r"Software\Chromium\NativeMessagingHosts",
            r"Software\Microsoft\Edge\NativeMessagingHosts",
            r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
        ):
            try:
                key = winreg.CreateKeyEx(
                    winreg.HKEY_CURRENT_USER, vendor + "\\" + HOST_NAME, 0, winreg.KEY_WRITE
                )
                with key:
                    winreg.SetValueEx(key, None, 0, winreg.REG_SZ, str(manifest_path))
                print("Registered: HKCU\\{0}\\{1}".format(vendor, HOST_NAME))
            except OSError as exc:
                print("Could not write {0}: {1}".format(vendor, exc))
    else:
        for directory in _browser_manifest_dirs():
            parent = directory.parent
            # Only install for browsers that are actually present.
            if not parent.exists() and not directory.exists():
                continue
            try:
                directory.mkdir(parents=True, exist_ok=True)
                path = directory / (HOST_NAME + ".json")
                path.write_text(blob, encoding="utf-8")
                written.append(path)
                print("Installed: {0}".format(path))
            except OSError as exc:
                print("Could not write {0}: {1}".format(directory, exc))

    if not written:
        print("No supported browser directory was found. Is Chrome installed for this user?")
        return 1

    info = ffmpeg_info()
    print()
    print("Host script : {0}".format(target))
    print("Extension   : {0}".format(", ".join(clean_ids)))
    print("Downloads   : {0}".format(downloads_dir()))
    if info["available"]:
        print("ffmpeg      : {0} ({1})".format(info["version"] or "unknown version", info["path"]))
    else:
        print("ffmpeg      : NOT FOUND - install it, or Strategy B cannot run.")
        if sys.platform == "darwin":
            print("              brew install ffmpeg")
        elif os.name == "nt":
            print("              winget install Gyan.FFmpeg")
        else:
            print("              sudo apt install ffmpeg")
    print()
    print("Now fully quit and reopen the browser: native messaging hosts are")
    print("only re-read at startup.")
    return 0


def uninstall():
    removed = 0
    if os.name == "nt":
        import winreg

        for vendor in (
            r"Software\Google\Chrome\NativeMessagingHosts",
            r"Software\Chromium\NativeMessagingHosts",
            r"Software\Microsoft\Edge\NativeMessagingHosts",
            r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
        ):
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, vendor + "\\" + HOST_NAME)
                removed += 1
            except OSError:
                pass
    for directory in _browser_manifest_dirs():
        path = directory / (HOST_NAME + ".json")
        try:
            if path.exists():
                path.unlink()
                removed += 1
        except OSError:
            pass
    print("Removed {0} registration(s).".format(removed))
    return 0


def main():
    args = sys.argv[1:]

    if args and args[0] in ("--install", "-i"):
        raise SystemExit(install(args[1:]))
    if args and args[0] in ("--uninstall", "-u"):
        raise SystemExit(uninstall())
    if args and args[0] in ("--probe", "-p"):
        info = ffmpeg_info()
        print(json.dumps({"version": HOST_VERSION, "ffmpeg": info, "downloadsDir": str(downloads_dir())}, indent=2))
        raise SystemExit(0 if info["available"] else 1)
    if args and args[0] in ("--help", "-h"):
        print(__doc__)
        raise SystemExit(0)

    # Chrome appends the origin (and on Windows the parent window handle) as
    # argv, so unrecognised arguments mean "launched by the browser".
    try:
        serve()
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover
        log("fatal: {0!r}".format(exc))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
