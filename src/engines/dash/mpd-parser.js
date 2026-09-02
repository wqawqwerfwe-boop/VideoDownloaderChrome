/**
 * MPEG-DASH MPD parser.
 *
 * Produces the same normalised shape as the HLS parser so the orchestrator can
 * treat both protocols identically. Supports SegmentTemplate (with both
 * $Number$ and SegmentTimeline addressing), SegmentList and single-file
 * BaseURL + SegmentBase representations.
 *
 * @module engines/dash/mpd-parser
 */

import { parseXml, childrenNamed, firstNamed } from "./xml.js"

/** Known DRM system IDs. Presence of any of these means we stop and say so. */
const DRM_SYSTEMS = Object.freeze({
	"edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": "widevine",
	"9a04f079-9840-4286-ab92-e65be0885f95": "playready",
	"94ce86fb-07ff-4f43-adb8-93d2fa968ca2": "fairplay",
	"f239e769-efa3-4850-9c16-a903c6932efb": "adobe-primetime",
	"1077efec-c0b2-4d02-ace3-3c1e52e2fb4b": "w3c-common",
})

/**
 * Parse an ISO 8601 duration such as `PT1H23M45.678S`.
 * @param {string|undefined} value
 * @returns {number} seconds
 */
export function parseIsoDuration(value) {
	if (!value) return 0
	const m = /^(-)?P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(value.trim())
	if (!m) return 0
	const [, sign, y, mo, d, h, mi, s] = m
	const total =
		(Number(y) || 0) * 31536000 +
		(Number(mo) || 0) * 2592000 +
		(Number(d) || 0) * 86400 +
		(Number(h) || 0) * 3600 +
		(Number(mi) || 0) * 60 +
		(Number(s) || 0)
	return sign ? -total : total
}

/** @param {string} uri @param {string} base */
function resolve(uri, base) {
	try {
		return new URL(uri, base).href
	} catch {
		return uri
	}
}

/**
 * Expand `$RepresentationID$`, `$Number%05d$`, `$Bandwidth$` and `$Time$`.
 * @param {string} template
 * @param {{ RepresentationID?: string, Number?: number, Bandwidth?: number, Time?: number }} vars
 */
export function fillTemplate(template, vars) {
	return template.replace(/\$(\$|[A-Za-z]+)(?:%0(\d+)d)?\$/g, (match, name, width) => {
		if (name === "$") return "$"
		const value = vars[/** @type {keyof typeof vars} */ (name)]
		if (value === undefined || value === null) return match
		const str = String(value)
		return width ? str.padStart(Number(width), "0") : str
	})
}

/**
 * @param {import("./xml.js").XmlNode} node
 * @param {string} inheritedBase
 */
function baseUrlOf(node, inheritedBase) {
	const el = firstNamed(node, "BaseURL")
	const raw = el?.text?.trim()
	return raw ? resolve(raw, inheritedBase) : inheritedBase
}

/**
 * Walk up the inheritance chain for SegmentTemplate: Representation overrides
 * AdaptationSet overrides Period.
 * @param {Array<import("./xml.js").XmlNode>} scopes ordered outermost -> innermost
 * @param {string} name
 */
function inherited(scopes, name) {
	let found = null
	for (const scope of scopes) {
		const el = firstNamed(scope, name)
		if (el) found = el
	}
	return found
}

/**
 * @param {Array<import("./xml.js").XmlNode>} scopes
 * @returns {{ protected: boolean, scheme: string|null }}
 */
function detectDrm(scopes) {
	for (const scope of scopes) {
		for (const cp of childrenNamed(scope, "ContentProtection")) {
			const id = (cp.attrs.schemeIdUri || "").toLowerCase()
			const uuid = id.startsWith("urn:uuid:") ? id.slice(9) : ""
			if (uuid && uuid in DRM_SYSTEMS) return { protected: true, scheme: DRM_SYSTEMS[uuid] }
			if (id.includes("mpeg:dash:mp4protection")) {
				const value = (cp.attrs.value || "").toLowerCase()
				// cenc/cbcs signal common encryption, which always pairs with a DRM system.
				if (value === "cenc" || value === "cbcs") return { protected: true, scheme: "cenc" }
			}
		}
	}
	return { protected: false, scheme: null }
}

/**
 * Build the ordered segment plan for one Representation.
 * @returns {{ initSegment: Object|null, segments: Array<Object>, addressing: string }}
 */
function buildSegments(scopes, repId, bandwidth, base, periodDuration) {
	const template = inherited(scopes, "SegmentTemplate")
	const list = inherited(scopes, "SegmentList")

	if (template) {
		const a = template.attrs
		const timescale = Number(a.timescale) || 1
		const startNumber = a.startNumber !== undefined ? Number(a.startNumber) : 1
		const vars = { RepresentationID: repId, Bandwidth: bandwidth }
		const initSegment = a.initialization
			? { url: resolve(fillTemplate(a.initialization, vars), base), byteRange: null }
			: null

		const timeline = firstNamed(template, "SegmentTimeline")
		const segments = []

		if (timeline) {
			let number = startNumber
			let time = 0
			let first = true
			for (const s of childrenNamed(timeline, "S")) {
				const d = Number(s.attrs.d) || 0
				const r = Number(s.attrs.r) || 0
				if (s.attrs.t !== undefined) time = Number(s.attrs.t) || 0
				else if (!first) time += 0
				first = false
				// r = -1 means "repeat to the end of the period".
				const repeats = r < 0 ? Math.max(0, Math.ceil((periodDuration * timescale - time) / d) - 1) : r
				for (let k = 0; k <= repeats; k++) {
					segments.push({
						seq: segments.length,
						url: resolve(fillTemplate(a.media || "", { ...vars, Number: number, Time: time }), base),
						duration: d / timescale,
						byteRange: null,
						key: null,
						discontinuity: 0,
					})
					time += d
					number++
				}
			}
			return { initSegment, segments, addressing: "timeline" }
		}

		const segDuration = (Number(a.duration) || 0) / timescale
		const count = segDuration > 0 ? Math.ceil(periodDuration / segDuration) : 0
		for (let k = 0; k < count; k++) {
			segments.push({
				seq: k,
				url: resolve(fillTemplate(a.media || "", { ...vars, Number: startNumber + k, Time: k * (Number(a.duration) || 0) }), base),
				duration: segDuration,
				byteRange: null,
				key: null,
				discontinuity: 0,
			})
		}
		return { initSegment, segments, addressing: "number" }
	}

	if (list) {
		const init = firstNamed(list, "Initialization")
		const initSegment = init?.attrs.sourceURL ? { url: resolve(init.attrs.sourceURL, base), byteRange: null } : null
		const timescale = Number(list.attrs.timescale) || 1
		const dur = (Number(list.attrs.duration) || 0) / timescale
		const segments = childrenNamed(list, "SegmentURL").map((s, k) => ({
			seq: k,
			url: resolve(s.attrs.media || "", base),
			duration: dur,
			byteRange: s.attrs.mediaRange ? { header: `bytes=${s.attrs.mediaRange}` } : null,
			key: null,
			discontinuity: 0,
		}))
		return { initSegment, segments, addressing: "list" }
	}

	// No segment addressing at all: the Representation is one self-contained file.
	return {
		initSegment: null,
		segments: [{ seq: 0, url: base, duration: periodDuration, byteRange: null, key: null, discontinuity: 0 }],
		addressing: "single",
	}
}

/**
 * Parse an MPD into a normalised variant ladder.
 *
 * @param {string} xmlText
 * @param {string} manifestUrl
 * @returns {{
 *   type: "dash",
 *   duration: number,
 *   isLive: boolean,
 *   variants: Array<Object>,
 *   audioTracks: Array<Object>,
 *   drm: { protected: boolean, scheme: string|null }
 * }}
 */
export function parseMpd(xmlText, manifestUrl) {
	const mpd = parseXml(xmlText)
	if (mpd.name !== "MPD") throw new Error(`Expected <MPD> root, found <${mpd.name}>`)

	const isLive = (mpd.attrs.type || "static").toLowerCase() === "dynamic"
	const totalDuration = parseIsoDuration(mpd.attrs.mediaPresentationDuration)
	const mpdBase = baseUrlOf(mpd, manifestUrl)

	const variants = []
	const audioTracks = []
	let drm = { protected: false, scheme: /** @type {string|null} */ (null) }

	for (const period of childrenNamed(mpd, "Period")) {
		const periodBase = baseUrlOf(period, mpdBase)
		const periodDuration = parseIsoDuration(period.attrs.duration) || totalDuration

		for (const set of childrenNamed(period, "AdaptationSet")) {
			const setBase = baseUrlOf(set, periodBase)
			const setMime = set.attrs.mimeType || set.attrs.contentType || ""

			for (const rep of childrenNamed(set, "Representation")) {
				const scopes = [period, set, rep]
				const found = detectDrm([set, rep])
				if (found.protected) drm = found

				const repBase = baseUrlOf(rep, setBase)
				const mime = rep.attrs.mimeType || setMime
				const bandwidth = Number(rep.attrs.bandwidth) || 0
				const repId = rep.attrs.id || ""
				const plan = buildSegments(scopes, repId, bandwidth, repBase, periodDuration)

				const entry = {
					id: repId,
					url: manifestUrl,
					mimeType: mime,
					codecs: rep.attrs.codecs || set.attrs.codecs || "",
					bandwidth,
					width: Number(rep.attrs.width) || Number(set.attrs.maxWidth) || undefined,
					height: Number(rep.attrs.height) || Number(set.attrs.maxHeight) || undefined,
					frameRate: rep.attrs.frameRate ? evalFrameRate(rep.attrs.frameRate) : undefined,
					audioSamplingRate: Number(rep.attrs.audioSamplingRate) || undefined,
					language: set.attrs.lang || "",
					duration: periodDuration,
					addressing: plan.addressing,
					initSegment: plan.initSegment,
					segmentCount: plan.segments.length,
					segments: plan.segments,
				}

				if (mime.startsWith("audio/")) audioTracks.push(entry)
				else if (mime.startsWith("video/")) variants.push({ ...entry, needsMux: true })
			}
		}
	}

	variants.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth)
	audioTracks.sort((a, b) => b.bandwidth - a.bandwidth)

	// A video-only ladder with no audio Representations needs no muxing.
	if (audioTracks.length === 0) for (const v of variants) v.needsMux = false

	return { type: "dash", duration: totalDuration, isLive, variants, audioTracks, drm }
}

/** `frameRate` may be `25` or `30000/1001`. @param {string} raw */
function evalFrameRate(raw) {
	const [n, d] = raw.split("/")
	const num = Number(n)
	const den = d === undefined ? 1 : Number(d)
	return den ? Number((num / den).toFixed(3)) : undefined
}
