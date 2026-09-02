/**
 * Strategy A: the in-browser download engine.
 *
 * Runs in an offscreen document because the service worker cannot: MV3 evicts
 * it after ~30s idle, it has no DOM and therefore no `URL.createObjectURL`, and
 * it cannot hold a large buffer.
 *
 * Flow: rebuild the segment plan from the manifest, fetch with four requests in
 * flight, decrypt if needed, remux, stream to disk, and report progress.
 *
 * @module offscreen/downloader
 */

import { MSG, Target, FailureCode, EngineError } from "../shared/messages.js"
import { createLogger, setLogLevel } from "../shared/logger.js"
import { MediaKind, humanBytes } from "../shared/media-types.js"
import { parsePlaylist, parseMediaPlaylist } from "../engines/hls/parser.js"
import { parseMpd } from "../engines/dash/mpd-parser.js"
import { fetchBytes, fetchOrdered, KeyStore, DEFAULT_CONCURRENCY } from "./segment-fetcher.js"
import { SourceAssembler, BufferingNormalizer, combineSources } from "./assembler.js"

setLogLevel("info")
const log = createLogger("engine")

/** Progress updates are throttled to this interval. */
const PROGRESS_INTERVAL_MS = 250
/** Sliding window used to compute transfer speed. */
const SPEED_WINDOW_MS = 5000
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024

/** @type {Map<string, { controller: AbortController, sink: Sink|null }>} */
const jobs = new Map()
/** Completed outputs held until the service worker confirms the save. */
/** @type {Map<string, Sink>} */
const finished = new Map()

/* ================================================================== *
 * Output sinks
 * ================================================================== */

/**
 * @typedef {Object} Sink
 * @property {(bytes: Uint8Array) => Promise<void>} write
 * @property {() => Promise<{ url: string, size: number }>} finalize
 * @property {() => Promise<void>} release
 * @property {() => Promise<void>} abort
 */

/**
 * Streams to the origin private file system.
 *
 * This is the reason a multi-gigabyte download does not exhaust memory: bytes
 * go to a real file through a `FileSystemWritableFileStream` as they arrive,
 * and peak RAM stays flat regardless of output size. The blob URL handed to
 * `chrome.downloads` at the end is a reference to that file, not a copy of it.
 */
class OpfsSink {
	/** @param {string} name */
	static async create(name) {
		const root = await navigator.storage.getDirectory()
		const handle = await root.getFileHandle(name, { create: true })
		const writable = await handle.createWritable({ keepExistingData: false })
		return new OpfsSink(root, handle, writable, name)
	}

	constructor(root, handle, writable, name) {
		this.root = root
		this.handle = handle
		this.writable = writable
		this.name = name
		this.url = null
		this.closed = false
	}

	/** @param {Uint8Array} bytes */
	async write(bytes) {
		try {
			await this.writable.write(bytes)
		} catch (error) {
			throw new EngineError(FailureCode.QUOTA_EXCEEDED, "Ran out of local storage while writing the file", {
				cause: error,
			})
		}
	}

	async finalize() {
		await this.writable.close()
		this.closed = true
		const file = await this.handle.getFile()
		this.url = URL.createObjectURL(file)
		return { url: this.url, size: file.size }
	}

	async release() {
		if (this.url) {
			URL.revokeObjectURL(this.url)
			this.url = null
		}
		try {
			await this.root.removeEntry(this.name)
		} catch {
			/* already gone */
		}
	}

	async abort() {
		if (!this.closed) {
			try {
				await this.writable.abort()
			} catch {
				/* nothing useful to do */
			}
		}
		await this.release()
	}
}

/**
 * Fallback when OPFS is unavailable. Each write becomes its own `Blob` so the
 * underlying `ArrayBuffer` can be collected immediately - Chrome spills blob
 * storage to disk, so this is far cheaper than growing one array of typed
 * arrays, though still weaker than streaming to a file.
 */
class BlobSink {
	constructor() {
		/** @type {Array<Blob>} */
		this.parts = []
		this.size = 0
		this.url = null
	}

	/** @param {Uint8Array} bytes */
	async write(bytes) {
		// Copy out of the shared buffer before wrapping: subarrays of a fetched
		// segment would otherwise pin the whole segment.
		this.parts.push(new Blob([bytes.slice()]))
		this.size += bytes.byteLength
	}

	async finalize() {
		const blob = new Blob(this.parts, { type: "video/mp4" })
		this.parts = []
		this.url = URL.createObjectURL(blob)
		return { url: this.url, size: blob.size }
	}

	async release() {
		if (this.url) {
			URL.revokeObjectURL(this.url)
			this.url = null
		}
		this.parts = []
	}

	async abort() {
		await this.release()
	}
}

/**
 * @param {string} jobId
 * @returns {Promise<Sink>}
 */
async function createSink(jobId) {
	if (navigator.storage?.getDirectory) {
		try {
			return await OpfsSink.create(`ovd-${jobId}.mp4`)
		} catch (error) {
			log.warn("OPFS unavailable; falling back to blob assembly", error)
		}
	}
	return new BlobSink()
}

/* ================================================================== *
 * Plan building
 * ================================================================== */

/**
 * @param {string} url
 * @param {AbortSignal} signal
 */
async function fetchManifestText(url, signal) {
	const bytes = await fetchBytes(url, { signal })
	if (bytes.byteLength > MAX_MANIFEST_BYTES) {
		throw new EngineError(FailureCode.MANIFEST_UNPARSEABLE, "Manifest is implausibly large")
	}
	return new TextDecoder().decode(bytes)
}

/**
 * Rebuild the ordered segment plan for the selected variant.
 *
 * `probe.js` deliberately strips `segments` before storing an entry, so the
 * registry holds the variant ladder but never the plan; it has to be recovered
 * from the manifest here. That is the right trade - a 6-hour stream is tens of
 * thousands of segment URLs, and `chrome.storage.session` is not the place for
 * them.
 *
 * @param {{ url: string, kind: string, drm?: Object }} entry
 * @param {number|undefined} variantIndex
 * @param {AbortSignal} signal
 */
async function buildPlan(entry, variantIndex, signal) {
	const text = await fetchManifestText(entry.url, signal)
	const isDash = entry.kind === MediaKind.DASH || text.trimStart().startsWith("<")

	return isDash ? await planDash(text, entry, variantIndex) : await planHls(text, entry, variantIndex, signal)
}

/**
 * @param {string} text
 * @param {Object} entry
 * @param {number|undefined} variantIndex
 * @param {AbortSignal} signal
 */
async function planHls(text, entry, variantIndex, signal) {
	let parsed
	try {
		parsed = parsePlaylist(text, entry.url)
	} catch (error) {
		throw new EngineError(FailureCode.MANIFEST_UNPARSEABLE, error?.message || "Unreadable HLS playlist", {
			cause: error,
		})
	}

	if (parsed.drm?.protected) {
		throw new EngineError(FailureCode.DRM_PROTECTED, `Stream is ${parsed.drm.scheme}-protected`, { retryable: false })
	}

	// A media playlist is already the plan.
	if (parsed.type === "media") {
		return {
			isLive: parsed.isLive,
			duration: parsed.duration,
			video: {
				initSegment: parsed.initSegment,
				segments: parsed.segments,
				segmentDuration: parsed.targetDuration,
			},
			audio: null,
		}
	}

	const variant = parsed.variants[variantIndex ?? 0]
	if (!variant) throw new EngineError(FailureCode.MANIFEST_UNPARSEABLE, "Selected quality is no longer in the playlist")

	const media = parseMediaPlaylist(await fetchManifestText(variant.url, signal), variant.url)
	if (media.drm?.protected) {
		throw new EngineError(FailureCode.DRM_PROTECTED, `Stream is ${media.drm.scheme}-protected`, { retryable: false })
	}

	let audio = null
	if (variant.audioGroup) {
		// Prefer the rendition the packager marked DEFAULT; fall back to the first
		// in the group that actually has its own playlist URL.
		const group = parsed.audioRenditions.filter((item) => item.groupId === variant.audioGroup && item.url)
		const chosen = group.find((item) => item.default) ?? group[0]
		if (chosen) {
			const audioMedia = parseMediaPlaylist(await fetchManifestText(chosen.url, signal), chosen.url)
			if (audioMedia.segments.length) {
				audio = {
					initSegment: audioMedia.initSegment,
					segments: audioMedia.segments,
					segmentDuration: audioMedia.targetDuration,
					label: chosen.name || chosen.language || "audio",
				}
			}
		}
	}

	return {
		isLive: media.isLive,
		duration: media.duration,
		video: { initSegment: media.initSegment, segments: media.segments, segmentDuration: media.targetDuration },
		audio,
	}
}

/**
 * @param {string} text
 * @param {Object} entry
 * @param {number|undefined} variantIndex
 */
async function planDash(text, entry, variantIndex) {
	let parsed
	try {
		parsed = parseMpd(text, entry.url)
	} catch (error) {
		throw new EngineError(FailureCode.MANIFEST_UNPARSEABLE, error?.message || "Unreadable MPD", { cause: error })
	}

	if (parsed.drm?.protected) {
		throw new EngineError(FailureCode.DRM_PROTECTED, `Stream is ${parsed.drm.scheme}-protected`, { retryable: false })
	}

	const variant = parsed.variants[variantIndex ?? 0] ?? parsed.audioTracks[0]
	if (!variant) throw new EngineError(FailureCode.MANIFEST_UNPARSEABLE, "No playable representation in the MPD")

	const averageSegment = variant.segments.length ? variant.duration / variant.segments.length : 0

	let audio = null
	if (variant.needsMux && parsed.audioTracks.length) {
		const chosen = parsed.audioTracks[0]
		audio = {
			initSegment: chosen.initSegment,
			segments: chosen.segments,
			segmentDuration: chosen.segments.length ? chosen.duration / chosen.segments.length : 0,
			label: chosen.language || "audio",
		}
	}

	return {
		isLive: parsed.isLive,
		duration: parsed.duration,
		video: { initSegment: variant.initSegment, segments: variant.segments, segmentDuration: averageSegment },
		audio,
	}
}

/* ================================================================== *
 * Progress
 * ================================================================== */

/**
 * Reports percentage, bytes received and speed to the popup.
 *
 * Percentage is derived from completed segments rather than bytes, because the
 * total byte count of a segmented stream is genuinely unknown until the last
 * segment lands. Segment counts are exact, so the bar never has to jump
 * backwards when an estimate is corrected.
 */
class ProgressReporter {
	/** @param {string} jobId @param {number} totalSegments */
	constructor(jobId, totalSegments) {
		this.jobId = jobId
		this.totalSegments = Math.max(1, totalSegments)
		this.doneSegments = 0
		this.bytesReceived = 0
		this.startedAt = Date.now()
		this.lastSentAt = 0
		/** @type {Array<{ at: number, bytes: number }>} */
		this.window = []
		this.phase = "fetching"
	}

	/** @param {number} bytes */
	add(bytes) {
		this.bytesReceived += bytes
		this.doneSegments++

		const now = Date.now()
		this.window.push({ at: now, bytes })
		while (this.window.length && now - this.window[0].at > SPEED_WINDOW_MS) this.window.shift()

		this.maybeSend()
	}

	/** @param {string} phase */
	setPhase(phase) {
		this.phase = phase
		this.send()
	}

	speed() {
		if (this.window.length < 2) return 0
		const span = (this.window[this.window.length - 1].at - this.window[0].at) / 1000
		if (span <= 0) return 0
		const bytes = this.window.reduce((sum, item) => sum + item.bytes, 0)
		return bytes / span
	}

	maybeSend() {
		const now = Date.now()
		// A 3000-segment stream would otherwise post 3000 messages as fast as the
		// network allows.
		if (now - this.lastSentAt < PROGRESS_INTERVAL_MS) return
		this.send()
	}

	send() {
		this.lastSentAt = Date.now()
		const percent = Math.min(99, Math.round((this.doneSegments / this.totalSegments) * 100))
		const speed = this.speed()
		const remaining = Math.max(0, this.totalSegments - this.doneSegments)
		const perSegment = this.doneSegments > 0 ? this.bytesReceived / this.doneSegments : 0

		void post({
			type: MSG.ENGINE_PROGRESS,
			target: Target.SERVICE_WORKER,
			jobId: this.jobId,
			phase: this.phase,
			percent,
			bytesReceived: this.bytesReceived,
			segmentsDone: this.doneSegments,
			segmentsTotal: this.totalSegments,
			speed,
			etaSeconds: speed > 0 && perSegment > 0 ? Math.round((remaining * perSegment) / speed) : null,
		})
	}
}

/** @param {unknown} message */
async function post(message) {
	try {
		await chrome.runtime.sendMessage(message)
	} catch {
		/* the worker may be asleep; progress is advisory */
	}
}

/* ================================================================== *
 * The job
 * ================================================================== */

/**
 * @param {{ jobId: string, entry: Object, variantIndex?: number, filename: string }} request
 */
async function runJob(request) {
	const { jobId, entry, variantIndex, filename } = request
	const controller = new AbortController()
	const signal = controller.signal
	const state = { controller, sink: null }
	jobs.set(jobId, state)

	/** @type {Set<string>} */
	const warnings = new Set()
	const onWarning = (text) => {
		if (!warnings.has(text)) {
			warnings.add(text)
			log.warn(text)
		}
	}

	try {
		// The DRM refusal is re-checked here, not just in the UI, so it cannot be
		// bypassed by crafting a message.
		if (entry.drm?.protected) {
			throw new EngineError(FailureCode.DRM_PROTECTED, `Stream is ${entry.drm.scheme}-protected`, {
				retryable: false,
			})
		}

		const plan = await buildPlan(entry, variantIndex, signal)

		if (!plan.video.segments.length) {
			throw new EngineError(FailureCode.MANIFEST_UNPARSEABLE, "The playlist contains no segments")
		}
		if (plan.isLive) {
			onWarning("Live playlist: only the currently published window can be captured")
		}

		const totalSegments =
			plan.video.segments.length + (plan.audio ? plan.audio.segments.length : 0)
		const progress = new ProgressReporter(jobId, totalSegments)
		progress.send()

		const keyStore = new KeyStore({ signal })
		const sink = await createSink(jobId)
		state.sink = sink

		if (plan.audio) {
			// Two sources: both must be fully normalised before either can be
			// written, because the output needs one movie box describing both.
			const video = new BufferingNormalizer({ onWarning })
			const audioNormalizer = new BufferingNormalizer({ onWarning })

			await pump(plan.video, video, { signal, keyStore, progress })
			await pump(plan.audio, audioNormalizer, { signal, keyStore, progress })

			progress.setPhase("muxing")
			const combined = combineSources({
				video: video.result(),
				audio: audioNormalizer.result(),
				videoSegmentDuration: plan.video.segmentDuration,
				audioSegmentDuration: plan.audio.segmentDuration,
				onWarning,
			})
			await sink.write(combined)
		} else {
			// Single source: stream straight to the sink, so peak memory is a
			// handful of segments no matter how long the video is.
			const assembler = new SourceAssembler({ onWarning })
			await pump(plan.video, assembler, { signal, keyStore, progress, sink })
			const tail = assembler.finish()
			if (tail) await sink.write(tail)
		}

		progress.setPhase("saving")
		const { url, size } = await sink.finalize()

		if (size === 0) {
			throw new EngineError(FailureCode.SEGMENT_FAILED, "Assembly produced an empty file")
		}

		finished.set(jobId, sink)
		jobs.delete(jobId)

		log.info(`job ${jobId} complete: ${humanBytes(size)}`)
		await post({
			type: MSG.ENGINE_RESULT,
			target: Target.SERVICE_WORKER,
			jobId,
			ok: true,
			blobUrl: url,
			size,
			filename,
			warnings: [...warnings],
		})
	} catch (error) {
		jobs.delete(jobId)
		if (state.sink) await state.sink.abort().catch(() => {})

		const mapped = toEngineError(error)
		log.warn(`job ${jobId} failed: ${mapped.code} - ${mapped.message}`)

		await post({
			type: MSG.ENGINE_RESULT,
			target: Target.SERVICE_WORKER,
			jobId,
			ok: false,
			code: mapped.code,
			message: mapped.message,
			retryable: mapped.retryable,
			warnings: [...warnings],
		})
	}
}

/**
 * Fetch one source's segments and feed them through an assembler.
 *
 * @param {{ initSegment: Object|null, segments: Array<Object> }} source
 * @param {{ accept: Function }} assembler
 * @param {{ signal: AbortSignal, keyStore: KeyStore, progress: ProgressReporter, sink?: Sink }} context
 */
async function pump(source, assembler, { signal, keyStore, progress, sink }) {
	if (source.initSegment?.url) {
		const bytes = await fetchBytes(source.initSegment.url, {
			rangeHeader: source.initSegment.byteRange?.header ?? null,
			signal,
		})
		const out = assembler.accept(bytes, { isInit: true })
		if (out && sink) await sink.write(out)
		progress.bytesReceived += bytes.byteLength
	}

	for await (const { index, bytes } of fetchOrdered(source.segments, {
		concurrency: DEFAULT_CONCURRENCY,
		signal,
		keyStore,
	})) {
		const out = assembler.accept(bytes, { isInit: false })
		if (out && sink) await sink.write(out)
		progress.add(bytes.byteLength)
		if (index % 50 === 0) log.debug(`segment ${index + 1}/${source.segments.length}`)
	}
}

/**
 * Normalise anything thrown into a coded error.
 * @param {unknown} error
 * @returns {EngineError}
 */
function toEngineError(error) {
	if (error instanceof EngineError) return error

	if (error?.name === "AbortError") return new EngineError(FailureCode.CANCELLED, "Cancelled")

	// Allocation failures surface as RangeError, and Chrome also throws plain
	// Errors mentioning allocation size when a Blob or buffer gets too big.
	if (error instanceof RangeError || /allocation|out of memory|Array buffer/i.test(error?.message || "")) {
		return new EngineError(FailureCode.MEMORY_LIMIT, "Ran out of memory assembling the file", { cause: error })
	}

	if (error instanceof TypeError && /fetch/i.test(error?.message || "")) {
		return new EngineError(FailureCode.CORS_BLOCKED, "A segment request was blocked by the browser", { cause: error })
	}

	return new EngineError(FailureCode.UNKNOWN, error?.message || String(error), { cause: error })
}

/* ================================================================== *
 * Message handling
 * ================================================================== */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	// Every context receives every message. Anything not addressed here must be
	// left alone, or this listener would answer popup->worker traffic and win
	// the race for the reply.
	if (message?.target !== Target.OFFSCREEN) return undefined

	switch (message.type) {
		case MSG.ENGINE_PING:
			sendResponse({ ok: true, jobs: [...jobs.keys()] })
			return false

		case MSG.ENGINE_RUN:
			// Acknowledge immediately and report the outcome via ENGINE_RESULT. A
			// download can run for many minutes; holding a sendMessage channel open
			// that long is not something to rely on.
			void runJob(message)
			sendResponse({ ok: true, accepted: true })
			return false

		case MSG.ENGINE_CANCEL: {
			const state = jobs.get(message.jobId)
			state?.controller.abort()
			sendResponse({ ok: true, cancelled: Boolean(state) })
			return false
		}

		case MSG.ENGINE_RELEASE: {
			const sink = finished.get(message.jobId)
			finished.delete(message.jobId)
			void sink?.release()
			sendResponse({ ok: true })
			return false
		}

		default:
			return undefined
	}
})

log.info("offscreen engine ready")
