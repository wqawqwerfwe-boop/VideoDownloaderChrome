/**
 * Media classification primitives shared by the sniffer, the engines and the UI.
 * @module shared/media-types
 */

export const MediaKind = Object.freeze({
	PROGRESSIVE: "progressive",
	HLS: "hls",
	DASH: "dash",
	SEGMENT: "segment",
	UNKNOWN: "unknown",
})

/** The three tiers of the download cascade. See docs/ARCHITECTURE.md. */
export const Strategy = Object.freeze({
	BROWSER: "browser",
	COMPANION: "companion",
	CAPTURE: "capture",
})

const MIME_HLS = new Set([
	"application/vnd.apple.mpegurl",
	"application/x-mpegurl",
	"audio/mpegurl",
	"audio/x-mpegurl",
	"vnd.apple.mpegurl",
])

const MIME_DASH = new Set(["application/dash+xml", "video/vnd.mpeg.dash.mpd"])

/** Extension -> mime for progressive containers we can hand straight to the downloader. */
const PROGRESSIVE_EXT = Object.freeze({
	mp4: "video/mp4",
	m4v: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
	ogv: "video/ogg",
	avi: "video/x-msvideo",
	flv: "video/x-flv",
	wmv: "video/x-ms-wmv",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	ogg: "audio/ogg",
	opus: "audio/opus",
	wav: "audio/wav",
	flac: "audio/flac",
})

/** Fragments of an adaptive stream. Individually useless, so never surfaced. */
const SEGMENT_EXT = new Set(["ts", "m4s", "cmfv", "cmfa", "cmft", "dash", "fmp4"])

/** Blob and data URLs can never be re-fetched from the background context. */
const UNFETCHABLE = /^(blob:|data:|filesystem:|chrome-extension:)/i

/**
 * @param {string} url
 * @returns {{ pathname: string, ext: string, host: string } | null}
 */
function dissect(url) {
	try {
		const u = new URL(url)
		const pathname = u.pathname || ""
		const m = /\.([a-z0-9]{1,6})$/i.exec(pathname)
		return { pathname, ext: m ? m[1].toLowerCase() : "", host: u.host }
	} catch {
		return null
	}
}

/**
 * Classify a URL + optional Content-Type into a MediaKind.
 *
 * Content-Type wins when present and meaningful, because CDNs routinely serve
 * manifests from extension-less or query-mangled paths. URL heuristics are the
 * fallback, because plenty of origins mislabel manifests as `text/plain` or
 * `application/octet-stream`.
 *
 * @param {{ url: string, mimeType?: string }} input
 * @returns {{ kind: string, container: string, mimeType: string }}
 */
export function classify({ url, mimeType }) {
	const mime = (mimeType || "").split(";")[0].trim().toLowerCase()
	const parts = dissect(url)
	const ext = parts?.ext ?? ""

	if (MIME_HLS.has(mime) || ext === "m3u8" || ext === "m3u") {
		return { kind: MediaKind.HLS, container: "hls", mimeType: mime || "application/vnd.apple.mpegurl" }
	}
	if (MIME_DASH.has(mime) || ext === "mpd") {
		return { kind: MediaKind.DASH, container: "dash", mimeType: mime || "application/dash+xml" }
	}
	if (SEGMENT_EXT.has(ext)) {
		return { kind: MediaKind.SEGMENT, container: ext, mimeType: mime }
	}
	if (ext && ext in PROGRESSIVE_EXT) {
		return { kind: MediaKind.PROGRESSIVE, container: ext, mimeType: mime || PROGRESSIVE_EXT[ext] }
	}
	if (mime.startsWith("video/") || mime.startsWith("audio/")) {
		const container = mime.split("/")[1].replace(/^x-/, "")
		return { kind: MediaKind.PROGRESSIVE, container, mimeType: mime }
	}
	return { kind: MediaKind.UNKNOWN, container: ext, mimeType: mime }
}

/** @param {string} url */
export function isFetchable(url) {
	return typeof url === "string" && url.length > 0 && !UNFETCHABLE.test(url)
}

/**
 * Adaptive players request hundreds of numbered fragments per minute. Anything
 * that looks like `seg-00042.ts` or `chunk_1080p_17.m4s` is noise.
 * @param {string} url
 */
export function looksLikeSegment(url) {
	const parts = dissect(url)
	if (!parts) return false
	if (SEGMENT_EXT.has(parts.ext)) return true
	return /(?:seg|segment|chunk|frag|media)[-_]?\d{2,}/i.test(parts.pathname)
}

/** @param {number} bytes */
export function humanBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "\u2014"
	const units = ["B", "KB", "MB", "GB", "TB"]
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
	const v = bytes / 1024 ** i
	return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** @param {number} bps bits per second */
export function humanBitrate(bps) {
	if (!Number.isFinite(bps) || bps <= 0) return "\u2014"
	if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`
	if (bps >= 1e3) return `${Math.round(bps / 1e3)} kbps`
	return `${Math.round(bps)} bps`
}

/** @param {number} seconds */
export function humanDuration(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0) return "\u2014"
	const s = Math.round(seconds)
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	const sec = s % 60
	const pad = (n) => String(n).padStart(2, "0")
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/**
 * Map a vertical resolution onto a familiar tier name.
 * @param {number|undefined} width
 * @param {number|undefined} height
 */
export function qualityLabel(width, height) {
	if (!height) return width ? `${width}w` : "Unknown"
	if (height >= 4300) return "8K"
	if (height >= 2100) return "4K"
	if (height >= 1400) return "1440p"
	if (height >= 1000) return "1080p"
	if (height >= 680) return "720p"
	if (height >= 460) return "480p"
	if (height >= 340) return "360p"
	if (height >= 220) return "240p"
	return `${height}p`
}

/**
 * Estimate transfer size from declared bandwidth and duration. This is what the
 * popup shows before a job starts; it is an estimate, never a promise.
 * @param {number|undefined} bandwidthBps
 * @param {number|undefined} durationSec
 */
export function estimateBytes(bandwidthBps, durationSec) {
	if (!bandwidthBps || !durationSec) return 0
	return Math.round((bandwidthBps / 8) * durationSec)
}

/**
 * Build a filesystem-safe filename.
 * @param {string} title
 * @param {string} suffix
 * @param {string} ext
 */
export function safeFilename(title, suffix, ext) {
	const base = (title || "video")
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120) || "video"
	const tail = suffix ? ` [${suffix}]` : ""
	return `${base}${tail}.${ext}`
}
