/**
 * HLS playlist parser (RFC 8216).
 *
 * Handles master playlists (variant ladder + alternate renditions) and media
 * playlists (segments, byte ranges, AES-128 keys, init maps, discontinuities).
 * Pure and dependency-free so it runs identically in the service worker, the
 * offscreen document and a worker.
 *
 * @module engines/hls/parser
 */

/**
 * Parse an HLS attribute list: `A=1,B="two,three",C=0x1F`.
 * Commas inside quoted values must not split.
 * @param {string} input
 * @returns {Record<string, string>}
 */
export function parseAttributes(input) {
	/** @type {Record<string, string>} */
	const out = {}
	let i = 0
	while (i < input.length) {
		const eq = input.indexOf("=", i)
		if (eq === -1) break
		const key = input.slice(i, eq).trim()
		i = eq + 1
		let value = ""
		if (input[i] === '"') {
			const end = input.indexOf('"', i + 1)
			value = input.slice(i + 1, end === -1 ? input.length : end)
			i = end === -1 ? input.length : end + 1
			const comma = input.indexOf(",", i)
			i = comma === -1 ? input.length : comma + 1
		} else {
			const comma = input.indexOf(",", i)
			const end = comma === -1 ? input.length : comma
			value = input.slice(i, end).trim()
			i = end + 1
		}
		if (key) out[key] = value
	}
	return out
}

/** @param {string} text */
function lines(text) {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
}

/** @param {string} uri @param {string} base */
function resolve(uri, base) {
	try {
		return new URL(uri, base).href
	} catch {
		return uri
	}
}

/** @param {string} text */
export function isMasterPlaylist(text) {
	return /^#EXT-X-STREAM-INF:/m.test(text)
}

/** @param {string} text */
export function isPlaylist(text) {
	return /^#EXTM3U/.test(text.trimStart())
}

/**
 * `RESOLUTION=1920x1080` -> `{ width, height }`
 * @param {string|undefined} value
 */
function parseResolution(value) {
	if (!value) return {}
	const m = /^(\d+)\s*x\s*(\d+)$/i.exec(value.trim())
	return m ? { width: Number(m[1]), height: Number(m[2]) } : {}
}

/**
 * Parse a master playlist into a normalised variant ladder.
 *
 * @param {string} text raw playlist body
 * @param {string} baseUrl absolute URL the playlist was fetched from
 * @returns {{
 *   type: "master",
 *   variants: Array<Object>,
 *   audioRenditions: Array<Object>,
 *   subtitleRenditions: Array<Object>,
 *   drm: { protected: boolean, scheme: string|null }
 * }}
 */
export function parseMasterPlaylist(text, baseUrl) {
	const rows = lines(text)
	const variants = []
	const audioRenditions = []
	const subtitleRenditions = []
	let drm = { protected: false, scheme: /** @type {string|null} */ (null) }
	let pending = null

	for (let i = 0; i < rows.length; i++) {
		const line = rows[i]

		if (line.startsWith("#EXT-X-SESSION-KEY:")) {
			const attrs = parseAttributes(line.slice("#EXT-X-SESSION-KEY:".length))
			const detected = detectHlsDrm(attrs)
			if (detected) drm = { protected: true, scheme: detected }
			continue
		}

		if (line.startsWith("#EXT-X-MEDIA:")) {
			const a = parseAttributes(line.slice("#EXT-X-MEDIA:".length))
			const rendition = {
				type: a.TYPE || "",
				groupId: a["GROUP-ID"] || "",
				name: a.NAME || "",
				language: a.LANGUAGE || "",
				channels: a.CHANNELS || "",
				default: a.DEFAULT === "YES",
				url: a.URI ? resolve(a.URI, baseUrl) : null,
			}
			if (rendition.type === "AUDIO") audioRenditions.push(rendition)
			else if (rendition.type === "SUBTITLES" || rendition.type === "CLOSED-CAPTIONS") subtitleRenditions.push(rendition)
			continue
		}

		if (line.startsWith("#EXT-X-STREAM-INF:")) {
			pending = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length))
			continue
		}

		// I-frame-only ladders are for trick play; not user-downloadable content.
		if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) continue
		if (line.startsWith("#")) continue

		if (pending) {
			const { width, height } = parseResolution(pending.RESOLUTION)
			const bandwidth = Number(pending["AVERAGE-BANDWIDTH"] || pending.BANDWIDTH || 0)
			variants.push({
				url: resolve(line, baseUrl),
				bandwidth,
				width,
				height,
				codecs: pending.CODECS || "",
				frameRate: pending["FRAME-RATE"] ? Number(pending["FRAME-RATE"]) : undefined,
				audioGroup: pending.AUDIO || null,
				subtitleGroup: pending.SUBTITLES || null,
				/** true when video and audio live in separate playlists and must be muxed */
				needsMux: Boolean(pending.AUDIO),
			})
			pending = null
		}
	}

	variants.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth)
	return { type: "master", variants, audioRenditions, subtitleRenditions, drm }
}

/**
 * SAMPLE-AES with a `skd://` key URI is FairPlay. That is DRM and is out of
 * scope; we detect it so the UI can say so plainly instead of failing obscurely.
 * Plain AES-128 with an http(s) key URI is ordinary RFC 8216 transport
 * encryption and is supported.
 * @param {Record<string,string>} attrs
 * @returns {string|null}
 */
export function detectHlsDrm(attrs) {
	const method = (attrs.METHOD || "").toUpperCase()
	const keyFormat = (attrs.KEYFORMAT || "").toLowerCase()
	const uri = (attrs.URI || "").toLowerCase()
	if (method === "NONE" || method === "") return null
	if (uri.startsWith("skd://") || keyFormat.includes("streamingkeydelivery")) return "fairplay"
	if (keyFormat.includes("widevine")) return "widevine"
	if (keyFormat.includes("playready") || keyFormat.includes("microsoft")) return "playready"
	if (method.startsWith("SAMPLE-AES")) return "sample-aes"
	return null
}

/**
 * Parse a media playlist into an ordered segment plan.
 *
 * @param {string} text
 * @param {string} baseUrl
 * @returns {{
 *   type: "media",
 *   targetDuration: number,
 *   mediaSequence: number,
 *   isLive: boolean,
 *   duration: number,
 *   initSegment: Object|null,
 *   segments: Array<Object>,
 *   drm: { protected: boolean, scheme: string|null }
 * }}
 */
export function parseMediaPlaylist(text, baseUrl) {
	const rows = lines(text)
	const segments = []

	let targetDuration = 0
	let mediaSequence = 0
	let endList = false
	let duration = 0
	let discontinuity = 0
	let initSegment = null
	let pendingDuration = 0
	let pendingTitle = ""
	let pendingByteRange = null
	let currentKey = null
	let drm = { protected: false, scheme: /** @type {string|null} */ (null) }
	let seq = 0

	for (const line of rows) {
		if (line.startsWith("#EXT-X-TARGETDURATION:")) {
			targetDuration = Number(line.slice(22)) || 0
		} else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
			mediaSequence = Number(line.slice(22)) || 0
			seq = mediaSequence
		} else if (line === "#EXT-X-ENDLIST") {
			endList = true
		} else if (line === "#EXT-X-DISCONTINUITY") {
			// Timestamps reset here; the remuxer must rebase rather than assume continuity.
			discontinuity++
		} else if (line.startsWith("#EXT-X-KEY:")) {
			const a = parseAttributes(line.slice(11))
			const scheme = detectHlsDrm(a)
			if (scheme) {
				drm = { protected: true, scheme }
				currentKey = null
			} else if ((a.METHOD || "").toUpperCase() === "AES-128") {
				currentKey = {
					method: "AES-128",
					url: a.URI ? resolve(a.URI, baseUrl) : null,
					// Absent IV means "use the media sequence number", per RFC 8216 s5.2.
					iv: a.IV || null,
				}
			} else {
				currentKey = null
			}
		} else if (line.startsWith("#EXT-X-MAP:")) {
			const a = parseAttributes(line.slice(11))
			initSegment = {
				url: a.URI ? resolve(a.URI, baseUrl) : null,
				byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, null) : null,
			}
		} else if (line.startsWith("#EXTINF:")) {
			const body = line.slice(8)
			const comma = body.indexOf(",")
			pendingDuration = Number(comma === -1 ? body : body.slice(0, comma)) || 0
			pendingTitle = comma === -1 ? "" : body.slice(comma + 1).trim()
		} else if (line.startsWith("#EXT-X-BYTERANGE:")) {
			pendingByteRange = parseByteRange(line.slice(17), segments[segments.length - 1] || null)
		} else if (!line.startsWith("#")) {
			segments.push({
				seq: seq++,
				url: resolve(line, baseUrl),
				duration: pendingDuration,
				title: pendingTitle,
				byteRange: pendingByteRange,
				key: currentKey,
				discontinuity,
			})
			duration += pendingDuration
			pendingDuration = 0
			pendingTitle = ""
			pendingByteRange = null
		}
	}

	return {
		type: "media",
		targetDuration,
		mediaSequence,
		isLive: !endList,
		duration,
		initSegment,
		segments,
		drm,
	}
}

/**
 * `#EXT-X-BYTERANGE:<length>[@<offset>]`. A missing offset means "immediately
 * after the previous segment".
 * @param {string} raw
 * @param {{ byteRange: { start: number, length: number } | null } | null} previous
 */
function parseByteRange(raw, previous) {
	const [lenStr, offStr] = raw.trim().split("@")
	const length = Number(lenStr)
	if (!Number.isFinite(length)) return null
	let start
	if (offStr !== undefined) {
		start = Number(offStr)
	} else if (previous?.byteRange) {
		start = previous.byteRange.start + previous.byteRange.length
	} else {
		start = 0
	}
	return { start, length, header: `bytes=${start}-${start + length - 1}` }
}

/**
 * Entry point: parse either flavour of playlist.
 * @param {string} text
 * @param {string} baseUrl
 */
export function parsePlaylist(text, baseUrl) {
	if (!isPlaylist(text)) throw new Error("Not an HLS playlist (missing #EXTM3U)")
	return isMasterPlaylist(text) ? parseMasterPlaylist(text, baseUrl) : parseMediaPlaylist(text, baseUrl)
}
