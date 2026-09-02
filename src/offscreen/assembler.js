/**
 * Stream assembly: turn fetched segments into one playable `.mp4`.
 *
 * Three paths, chosen by inspecting bytes rather than trusting the URL, because
 * CDNs serve TS payloads from `.m4s` paths and vice versa often enough that
 * extension-based dispatch produces corrupt files:
 *
 *   1. fMP4, single source     - init + segments written straight through
 *   2. MPEG-TS or bare ADTS    - demuxed and remuxed by the vendored mux.js
 *   3. separate audio + video  - both normalised to fMP4, samples extracted,
 *                                rewritten as one two-track file
 *
 * Path 3 is the interesting one. Two independent fMP4 streams cannot simply be
 * concatenated: each carries its own `moov` describing one track. Producing a
 * single file means reading the samples back out of both and writing a fresh
 * movie box that describes both tracks.
 *
 * @module offscreen/assembler
 */

import { FailureCode, EngineError } from "../shared/messages.js"
import { Transmuxer } from "../vendor/mux.js"
import {
	concat,
	sniffContainer,
	skipId3,
	parseInitSegment,
	extractFragmentSamples,
	buildInitSegment,
	buildMediaSegment,
} from "../vendor/mp4box.js"
import { createLogger } from "../shared/logger.js"

const log = createLogger("assembler")

/**
 * Ceiling for the two-source path, which must hold decoded sample references
 * for the whole output before it can write anything. Beyond this, the honest
 * answer is ffmpeg, not an out-of-memory crash halfway through.
 */
export const MAX_BUFFERED_BYTES = 1_500_000_000

/**
 * Assembles one source (one ordered list of segments) into MP4 chunks.
 *
 * Push segments in order; each `accept` returns bytes ready to write, or null
 * when the muxer needs more input before it can emit anything.
 */
export class SourceAssembler {
	/** @param {{ onWarning?: (text: string) => void }} [options] */
	constructor({ onWarning } = {}) {
		/** @type {"passthrough"|"transmux"|null} */
		this.mode = null
		this.transmuxer = null
		this.onWarning = onWarning ?? (() => {})
		this.initWritten = false
	}

	/**
	 * @param {Uint8Array} bytes
	 * @param {{ isInit?: boolean }} [options]
	 * @returns {Uint8Array|null}
	 */
	accept(bytes, { isInit = false } = {}) {
		if (!bytes.byteLength) return null

		if (this.mode === null) this.#chooseMode(bytes)

		if (this.mode === "passthrough") {
			// An fMP4 init segment followed by its media segments already is a
			// playable file. Nothing to rewrite.
			if (isInit) this.initWritten = true
			return bytes
		}

		// A TS stream has no separate init segment; if one was declared, it is a
		// mismatch worth reporting rather than feeding to the demuxer.
		if (isInit) {
			this.onWarning("Ignored an initialisation segment on a transport stream source")
			return null
		}

		this.transmuxer.push(bytes)
		return this.#drain(this.transmuxer.flush())
	}

	/** @returns {Uint8Array|null} */
	finish() {
		if (this.mode !== "transmux" || !this.transmuxer) return null
		return this.#drain(this.transmuxer.end())
	}

	/** @param {Uint8Array} bytes */
	#chooseMode(bytes) {
		const container = sniffContainer(skipId3(bytes))

		switch (container) {
			case "mp4":
				this.mode = "passthrough"
				log.info("source is fragmented MP4; writing through")
				break
			case "ts":
			case "adts":
				this.mode = "transmux"
				this.transmuxer = new Transmuxer()
				log.info(`source is ${container}; transmuxing to MP4`)
				break
			case "webm":
				throw new EngineError(
					FailureCode.UNSUPPORTED_CODEC,
					"WebM/Matroska segments cannot be remuxed in the browser"
				)
			default:
				// Try the demuxer anyway - a mid-stream TS can arrive without a
				// leading sync byte - but say so, because a silent empty output is
				// much harder to diagnose than a warning.
				this.onWarning("Unrecognised segment format; attempting to demux as a transport stream")
				this.mode = "transmux"
				this.transmuxer = new Transmuxer()
		}
	}

	/** @param {{ initSegment: Uint8Array|null, data: Uint8Array, warnings: Array<string>, fatal: string|null }} result */
	#drain(result) {
		for (const warning of result.warnings) this.onWarning(warning)

		if (result.fatal) {
			throw new EngineError(FailureCode.UNSUPPORTED_CODEC, result.fatal)
		}

		const parts = []
		if (result.initSegment) {
			parts.push(result.initSegment)
			this.initWritten = true
		}
		if (result.data.byteLength) parts.push(result.data)

		if (!parts.length) return null
		return parts.length === 1 ? parts[0] : concat(parts)
	}

	/** Description of what was actually muxed, for logging and the UI. */
	describe() {
		return this.transmuxer?.describe() ?? { mode: this.mode }
	}
}

/**
 * Collects one source into an in-memory fMP4 stream, preserving segment
 * boundaries so decode times can be recovered later.
 *
 * Only used on the two-source path, where nothing can be written until both
 * streams are known.
 */
export class BufferingNormalizer {
	/** @param {{ onWarning?: (text: string) => void }} [options] */
	constructor(options = {}) {
		this.assembler = new SourceAssembler(options)
		/** @type {Uint8Array|null} */
		this.init = null
		/** @type {Array<Uint8Array>} */
		this.segments = []
		this.bytes = 0
	}

	/**
	 * @param {Uint8Array} bytes
	 * @param {{ isInit?: boolean }} [options]
	 */
	accept(bytes, options = {}) {
		const out = this.assembler.accept(bytes, options)
		if (out) this.#store(out, options.isInit === true)
	}

	finish() {
		const out = this.assembler.finish()
		if (out) this.#store(out, false)
	}

	/**
	 * @param {Uint8Array} bytes
	 * @param {boolean} declaredInit
	 */
	#store(bytes, declaredInit) {
		this.bytes += bytes.byteLength
		if (this.bytes > MAX_BUFFERED_BYTES) {
			throw new EngineError(
				FailureCode.MEMORY_LIMIT,
				"Stream is too large to combine separate audio and video in the browser"
			)
		}

		// The first chunk of a transmuxed source carries ftyp+moov prepended to
		// its first fragment; split them so segment boundaries stay clean.
		if (!this.init) {
			const split = splitInitAndFragments(bytes)
			if (split) {
				this.init = split.init
				if (split.rest?.byteLength) this.segments.push(split.rest)
				return
			}
			if (declaredInit) {
				this.init = bytes
				return
			}
		}

		this.segments.push(bytes)
	}

	result() {
		if (!this.init) {
			throw new EngineError(FailureCode.MANIFEST_UNPARSEABLE, "Source produced no initialisation segment")
		}
		return { init: this.init, segments: this.segments, bytes: this.bytes }
	}
}

/**
 * Split a buffer that begins with `ftyp`/`moov` from whatever follows.
 * @param {Uint8Array} bytes
 * @returns {{ init: Uint8Array, rest: Uint8Array|null }|null}
 */
function splitInitAndFragments(bytes) {
	if (sniffContainer(bytes) !== "mp4") return null

	let offset = 0
	let sawMoov = false
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	while (offset + 8 <= bytes.byteLength) {
		const size = view.getUint32(offset)
		const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
		if (size < 8 || offset + size > bytes.byteLength) break

		if (type === "moof" || type === "mdat" || type === "styp") break
		if (type === "moov") sawMoov = true
		offset += size
	}

	if (!sawMoov || offset === 0) return null
	return {
		init: bytes.subarray(0, offset),
		rest: offset < bytes.byteLength ? bytes.subarray(offset) : null,
	}
}

/**
 * Recover absolute decode times for one segment's samples.
 *
 * `tfdt` gives the fragment's base decode time, and sample durations advance
 * from there. Some packagers write a zero `tfdt` in every fragment and rely on
 * `trex` defaults, so a running cursor is used whenever the declared base would
 * move backwards.
 *
 * @param {Array<Object>} samples
 * @param {number} cursor running decode time in the track's timescale
 * @param {number} fallbackDuration per-sample duration to use when the source declares none
 */
function absolutise(samples, cursor, fallbackDuration) {
	const base = samples[0]?.baseMediaDecodeTime ?? 0
	let time = base > cursor ? base : cursor
	const start = time

	const out = samples.map((sample) => {
		const duration = sample.duration > 0 ? sample.duration : fallbackDuration
		const entry = { data: sample.data, duration, isSync: sample.isSync, cts: sample.cts }
		time += duration
		return entry
	})

	return { samples: out, start, end: time }
}

/**
 * Pick the samples belonging to one source track out of an extraction result.
 * @param {Map<number, Array<Object>>} byTrack
 * @param {number} trackId
 */
function samplesFor(byTrack, trackId) {
	if (byTrack.has(trackId)) return byTrack.get(trackId)
	// A single-track segment may use any track id; if there is only one, it is
	// unambiguous regardless of what the init segment called it.
	if (byTrack.size === 1) return [...byTrack.values()][0]
	return null
}

/**
 * Combine a normalised video source and a normalised audio source into one
 * two-track MP4.
 *
 * Fragments are emitted whole and ordered by decode time rather than
 * interleaved sample by sample. A file of alternating video-only and audio-only
 * fragments is valid fMP4 and plays correctly, and it avoids having to align
 * segment boundaries that the two representations chose independently.
 *
 * @param {{
 *   video: { init: Uint8Array, segments: Array<Uint8Array> },
 *   audio: { init: Uint8Array, segments: Array<Uint8Array> },
 *   videoSegmentDuration?: number,
 *   audioSegmentDuration?: number,
 *   onWarning?: (text: string) => void
 * }} args
 * @returns {Uint8Array}
 */
export function combineSources({
	video,
	audio,
	videoSegmentDuration = 0,
	audioSegmentDuration = 0,
	onWarning = () => {},
}) {
	const videoInfo = parseInitSegment(video.init)
	const audioInfo = parseInitSegment(audio.init)

	const videoTrack = videoInfo.tracks.find((track) => track.kind === "video")
	const audioTrack = audioInfo.tracks.find((track) => track.kind === "audio")

	if (!videoTrack) {
		throw new EngineError(
			FailureCode.UNSUPPORTED_CODEC,
			describeUnsupported("video", videoInfo) ?? "No usable video track in the selected representation"
		)
	}
	if (!audioTrack) {
		throw new EngineError(
			FailureCode.UNSUPPORTED_CODEC,
			describeUnsupported("audio", audioInfo) ?? "No usable audio track in the selected representation"
		)
	}

	// If the video source already carried audio, a separate audio rendition
	// would duplicate it. Prefer the muxed one and say so.
	if (videoInfo.tracks.some((track) => track.kind === "audio")) {
		onWarning("Video source already contains audio; the separate audio rendition was skipped")
		return concatSource(video)
	}

	const outVideo = { ...videoTrack, id: 1 }
	const outAudio = { ...audioTrack, id: 2 }

	/** @type {Array<{ start: number, track: Object }>} */
	const fragments = []

	const gather = (source, sourceTrack, outId, timescale, segmentDuration) => {
		let cursor = 0
		for (const segment of source.segments) {
			const byTrack = extractFragmentSamples(segment)
			const samples = samplesFor(byTrack, sourceTrack.id)
			if (!samples?.length) continue

			const fallback =
				segmentDuration > 0 ? Math.max(1, Math.round((segmentDuration * timescale) / samples.length)) : 1
			const { samples: absolute, start, end } = absolutise(samples, cursor, fallback)
			cursor = end

			fragments.push({
				start: start / timescale,
				track: { id: outId, baseMediaDecodeTime: start, samples: absolute },
			})
		}
	}

	gather(video, videoTrack, 1, outVideo.timescale, videoSegmentDuration)
	gather(audio, audioTrack, 2, outAudio.timescale, audioSegmentDuration)

	if (!fragments.length) {
		throw new EngineError(FailureCode.SEGMENT_FAILED, "No samples could be recovered from the fetched segments")
	}

	// Stable sort by start time keeps each track's own fragments in order.
	fragments.sort((a, b) => a.start - b.start)

	const chunks = [buildInitSegment([outVideo, outAudio])]
	let sequenceNumber = 1
	for (const fragment of fragments) {
		chunks.push(buildMediaSegment({ sequenceNumber: sequenceNumber++, tracks: [fragment.track] }))
	}

	log.info(`combined ${fragments.length} fragments into a two-track file`)
	return concat(chunks)
}

/** @param {{ init: Uint8Array, segments: Array<Uint8Array> }} source */
function concatSource(source) {
	return concat([source.init, ...source.segments])
}

/**
 * @param {string} kind
 * @param {{ unsupported: Array<{ sampleEntry: string }> }} info
 */
function describeUnsupported(kind, info) {
	if (!info.unsupported.length) return null
	const names = [...new Set(info.unsupported.map((item) => item.sampleEntry))].join(", ")
	return `Unsupported ${kind} codec (${names}); the companion host can handle this`
}
