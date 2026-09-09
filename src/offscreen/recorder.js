/**
 * Strategy C: the offscreen capture recorder.
 *
 * Runs in an offscreen document (recorder.html, reason USER_MEDIA) because a
 * service worker has no DOM - no media elements, no captureStream, no
 * MediaRecorder - and a visible tab would put the machinery in the user's way.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Sample-AES streams: the manifest publishes its key next to the playlist
 * (which is what makes it transport encryption rather than licence-server
 * DRM), but the encryption is applied *inside* H.264/AAC samples, and no
 * engine this extension ships decrypts at sample level. A browser playing the
 * stream decrypts it as a matter of course, though. So instead of downloading,
 * this document plays the stream through the browser's own media stack and
 * records the decoded - i.e. already-decrypted - output with MediaRecorder,
 * one route per playback engine available:
 *
 *   1. native - <video src=manifest>. Works wherever the platform player
 *               handles the manifest itself (Safari's HLS, Android Chrome,
 *               and any plain progressive file everywhere).
 *   2. mse    - the same fetch + AES-128 decrypt + transmux pipeline strategy
 *               A uses, fed into a MediaSource instead of a file. Covers
 *               desktop Chrome for clear and AES-128 streams.
 *   3. tab    - records the source tab itself via the chrome.tabCapture
 *               streamId the worker minted. The page's own player is the
 *               decryptor here, which is what makes Sample-AES streams
 *               recordable on desktop Chrome.
 *
 * The first route that can actually decode wins; a route that cannot decode
 * bails out *before* recording anything, because a recording of undecodable
 * bytes is a file that looks fine and plays as noise.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a DRM bypass. Whenever the manifest is fetched here it is parsed and
 * re-checked, and a hard-DRM signature (Widevine, PlayReady, FairPlay
 * delivery, CENC) aborts the session before any capture begins. Only
 * Sample-AES - or an unencrypted stream - is ever recorded, mirroring the
 * companion host's own gate. And nothing is decrypted in this document that
 * the browser would not decrypt to play the stream anyway.
 *
 * PROTOCOL
 * --------
 * Speaks the strategy A engine's messages so the save path is shared:
 * ENGINE_PROGRESS while recording, ENGINE_RESULT (with a blob URL into the
 * origin private file system) when finished, ENGINE_RELEASE once the worker's
 * chrome.downloads transfer has drained it, ENGINE_CANCEL to stop - with
 * `finalize: true` meaning "stop but keep what you have". The worker performs
 * the actual file write: offscreen documents cannot call chrome.downloads,
 * so the recorder hands it a URL and the worker triggers the save.
 *
 * @module offscreen/recorder
 */

import { MSG, Target, FailureCode, EngineError } from "../shared/messages.js"
import { createLogger, setLogLevel } from "../shared/logger.js"
import { SAMPLE_AES_SCHEME, humanBytes } from "../shared/media-types.js"
import { parsePlaylist } from "../engines/hls/parser.js"
import { fetchOrdered, KeyStore, DEFAULT_CONCURRENCY } from "./segment-fetcher.js"
import { Transmuxer } from "../vendor/mux.js"

setLogLevel("info")
const log = createLogger("recorder")

/* ================================================================== *
 * Tuning
 * ================================================================== */

/** How long a playback route may take to produce its first frame. */
const START_TIMEOUT_MS = 15_000
/** Progress tick; also the MediaRecorder timeslice, so chunks land on disk. */
const TICK_MS = 1_000
/**
 * Recording is realtime, so a stalled player would sit forever. If the play
 * head stops advancing for this long, finalise what has been captured so far.
 */
const STALL_TIMEOUT_MS = 30_000
/** Slack after the expected runtime before a capture is cut short. */
const END_GRACE_SECONDS = 45
/** Ceiling for open-ended captures (live streams, unknown duration). */
const HARD_CAP_SECONDS = 2 * 60 * 60
/**
 * MediaRecorder candidates, most desirable first. MP4 keeps the H.264/AAC
 * codec family and plays everywhere; WebM is the long-supported fallback. The
 * container actually written decides the file extension handed to the worker.
 */
const RECORDER_MIME_LADDER = [
	{ mime: 'video/mp4;codecs="avc1.640028,mp4a.40.2"', ext: "mp4" },
	{ mime: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', ext: "mp4" },
	{ mime: "video/mp4", ext: "mp4" },
	{ mime: 'video/webm;codecs="vp9,opus"', ext: "webm" },
	{ mime: 'video/webm;codecs="vp8,opus"', ext: "webm" },
	{ mime: "video/webm", ext: "webm" },
]
/**
 * Header names `fetch` will not carry regardless of host permissions
 * (https://fetch.spec.whatwg.org/#forbidden-header-name). Referer and Origin
 * are restored on the wire by the session-scoped DNR rule download-engine
 * installs for this job; Cookie attaches itself via credentials:"include".
 * Everything else in the forwarded payload headers is passed through.
 */
const FORBIDDEN_FETCH_HEADERS = new Set([
	"referer",
	"origin",
	"cookie",
	"cookie2",
	"user-agent",
	"host",
	"connection",
	"content-length",
])

/** @type {Map<string, Object>} jobId -> live session */
const sessions = new Map()
/** @type {Map<string, Object>} jobId -> finished output awaiting the save */
const finished = new Map()

/* ================================================================== *
 * Small utilities
 * ================================================================== */

/** @param {Object} message */
async function post(message) {
	try {
		await chrome.runtime.sendMessage(message)
	} catch {
		/* the worker may be asleep; progress is advisory */
	}
}

/**
 * Await a DOM event once, with a deadline. Rejects on the target's `error`
 * event too, so a decode or network failure does not have to wait out the
 * timeout to be noticed.
 *
 * @param {EventTarget} target
 * @param {string} event
 * @param {number} timeoutMs
 * @returns {Promise<Event>}
 */
function once(target, event, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup()
			reject(new EngineError(FailureCode.ENGINE_UNAVAILABLE, `Timed out waiting for ${event}`))
		}, timeoutMs)

		const onEvent = (event_) => {
			cleanup()
			resolve(event_)
		}
		const onError = () => {
			cleanup()
			reject(new EngineError(FailureCode.ENGINE_UNAVAILABLE, `Failed while waiting for ${event}`))
		}

		function cleanup() {
			clearTimeout(timer)
			target.removeEventListener(event, onEvent)
			target.removeEventListener("error", onError)
		}

		target.addEventListener(event, onEvent, { once: true })
		target.addEventListener("error", onError, { once: true })
	})
}

/** @param {number} ms @param {AbortSignal} [signal] */
function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms)
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer)
				reject(new EngineError(FailureCode.CANCELLED, "Cancelled"))
			},
			{ once: true }
		)
	})
}

/** Normalise anything thrown into a coded error, mirroring the engine. */
function toEngineError(error) {
	if (error instanceof EngineError) return error
	if (error?.name === "AbortError") return new EngineError(FailureCode.CANCELLED, "Cancelled")
	if (error instanceof RangeError || /allocation|out of memory|Array buffer/i.test(error?.message || "")) {
		return new EngineError(FailureCode.MEMORY_LIMIT, "Ran out of memory while recording", { cause: error })
	}
	return new EngineError(FailureCode.UNKNOWN, error?.message || String(error), { cause: error })
}

/**
 * Thrown by a playback route that cannot decode this stream. Not an error in
 * the job sense: the session just falls through to the next route.
 */
class RouteFallback extends Error {
	/** @param {string} reason surfaced as a warning if a later route succeeds */
	constructor(reason) {
		super(reason)
		this.name = "RouteFallback"
		this.reason = reason
	}
}

/**
 * Fetch text with the forwarded page context. Non-forbidden payload headers
 * are passed through; cookies ride along via credentials.
 *
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {AbortSignal} signal
 */
async function fetchText(url, headers, signal) {
	const clean = {}
	for (const [key, value] of Object.entries(headers || {})) {
		if (!FORBIDDEN_FETCH_HEADERS.has(String(key).toLowerCase())) clean[key] = value
	}

	const response = await fetch(url, {
		method: "GET",
		credentials: "include",
		cache: "no-store",
		redirect: "follow",
		headers: clean,
		signal,
	})
	if (!response.ok) {
		throw new EngineError(
			response.status === 401 || response.status === 403 ? FailureCode.CORS_BLOCKED : FailureCode.SEGMENT_FAILED,
			`HTTP ${response.status} reading the manifest`
		)
	}
	const text = await response.text()
	return { text, finalUrl: response.url || url }
}

/**
 * Refuse hard DRM before any capture begins. Sample-AES is the one encrypted
 * scheme allowed through; everything else means a licence server and is out of
 * bounds for this extension.
 *
 * @param {{ protected: boolean, scheme: string|null }|null|undefined} drm
 */
function assertNotHardDrm(drm) {
	if (!drm?.protected) return
	if (drm.scheme === SAMPLE_AES_SCHEME) {
		throw new RouteFallback("Sample-AES segments need a player with sample-level decryption")
	}
	throw new EngineError(FailureCode.DRM_PROTECTED, `Stream is ${drm.scheme}-protected`, { retryable: false })
}

/** @param {string} mime */
function canPlayMime(mime) {
	try {
		return Boolean(document.createElement("video").canPlayType(mime))
	} catch {
		return false
	}
}

/**
 * @param {Array<{height?: number, bandwidth?: number, codecs?: string, url: string}>} variants
 * @param {number|null} requestedHeight
 */
function chooseVariant(variants, requestedHeight) {
	if (!variants?.length) return null
	const scored = [...variants].sort(
		(a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0)
	)
	if (!requestedHeight) return scored[0]
	return (
		scored.find((v) => v.height === requestedHeight) ??
		scored.reduce((best, v) =>
			Math.abs((v.height || 0) - requestedHeight) < Math.abs((best.height || 0) - requestedHeight) ? v : best
		)
	)
}

/**
 * A hidden-but-rendered video element. `display: none` is avoided on purpose:
 * some builds deprioritise decoding for elements outside the render tree, and
 * captureStream() is only as good as the frames the decoder produces. One
 * pixel in the corner, fully transparent, is invisible and safe.
 */
function hiddenVideo() {
	const video = document.createElement("video")
	video.playsInline = true
	video.preload = "auto"
	video.style.cssText =
		"position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1"
	document.body.append(video)
	return video
}

/**
 * Start playback, attempting audible playback first because captureStream
 * taps the element's output and a muted element can yield a silent audio
 * track. This document has no user activation, so the browser may only allow
 * muted autoplay; that is accepted with a warning rather than treated as a
 * route failure.
 *
 * @param {Object} session
 * @param {HTMLVideoElement} video
 * @param {string} label route name, for the log
 */
async function startPlayback(session, video, label) {
	try {
		await video.play()
		return true
	} catch (error) {
		if (error?.name === "NotAllowedError") {
			video.muted = true
			try {
				await video.play()
				session.warnings.add(
					`${label} playback had to be muted for autoplay; if the recording's audio is silent, retry once the page is audible`
				)
				return true
			} catch (mutedError) {
				log.warn(`${label}: even muted autoplay was refused`, mutedError)
				return false
			}
		}
		// Anything else (decode failure, unsupported source) is a real route
		// failure; the caller decides whether a later route gets a chance.
		log.debug(`${label}: play() refused`, error)
		return false
	}
}

/* ================================================================== *
 * The recording sink
 *
 * MediaRecorder chunks must not accumulate in memory: a two-hour capture at
 * source bitrate is gigabytes. Chunks stream into the origin private file
 * system as they arrive, and the blob URL handed to the worker references
 * that file rather than a copy of it. Same pattern as the strategy A engine.
 * ================================================================== */

class OpfsRecordingSink {
	/** @param {string} name */
	static async create(name) {
		const root = await navigator.storage.getDirectory()
		const handle = await root.getFileHandle(name, { create: true })
		const writable = await handle.createWritable({ keepExistingData: false })
		return new OpfsRecordingSink(root, handle, writable, name)
	}

	constructor(root, handle, writable, name) {
		this.root = root
		this.handle = handle
		this.writable = writable
		this.name = name
		this.url = null
		this.closed = false
		/** Serialized writes; finalize drains this before closing. */
		this.writeChain = Promise.resolve()
	}

	/**
	 * @param {Blob} chunk
	 * @returns {Promise<void>} rejects only if this chunk (or an earlier one) failed
	 */
	write(chunk) {
		this.writeChain = this.writeChain.then(() => this.writable.write(chunk))
		return this.writeChain
	}

	async finalize() {
		await this.writeChain.catch(() => {})
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

/* ================================================================== *
 * Session
 * ================================================================== */

/**
 * @param {{
 *   jobId: string,
 *   manifestUrl: string,
 *   kind?: string|null,
 *   filename?: string,
 *   headers?: Record<string, string>,
 *   duration?: number|null,
 *   quality?: { height?: number|null, bandwidth?: number|null }|null,
 *   tabId?: number,
 *   streamId?: string|null,
 *   pageUrl?: string|null,
 *   title?: string|null,
 * }} request
 */
async function runSession(request) {
	const jobId = String(request.jobId || "")
	if (!jobId) throw new EngineError(FailureCode.UNKNOWN, "Capture request has no jobId")
	if (typeof request.manifestUrl !== "string" || !/^https?:/i.test(request.manifestUrl)) {
		throw new EngineError(FailureCode.UNKNOWN, "Capture request has no usable manifest URL")
	}

	const controller = new AbortController()
	/** @type {Object} */
	const session = {
		jobId,
		controller,
		signal: controller.signal,
		filename: request.filename || "",
		quality: request.quality || null,
		warnings: new Set(),
		bytes: 0,
		segmentsDone: 0,
		recorder: null,
		stream: null,
		video: null,
		sink: null,
		stopped: false,
		stopReason: null,
		/** Set by recordStream; a graceful stop funnels through this. */
		stop: null,
	}
	sessions.set(jobId, session)

	const warn = (text) => {
		if (!session.warnings.has(text)) {
			session.warnings.add(text)
			log.warn(text)
		}
	}

	try {
		await captureWithRoutes(session, request, warn)
	} catch (error) {
		await teardownSession(session, { discardSink: true })
		sessions.delete(jobId)
		const mapped = toEngineError(error)
		log.warn(`job ${jobId} failed: ${mapped.code} - ${mapped.message}`)
		await post({
			type: MSG.ENGINE_RESULT,
			target: Target.SERVICE_WORKER,
			jobId,
			ok: false,
			code: mapped.code,
			message: mapped.message,
			retryable: false,
			warnings: [...session.warnings],
		})
	}
}

/**
 * Try each playback route in order. A RouteFallback from one route becomes a
 * warning if a later route succeeds, and the failure reason if none do.
 *
 * @param {Object} session
 * @param {Object} request
 * @param {(text: string) => void} warn
 * @returns {Promise<{ url: string, size: number, filename: string }>}
 */
async function captureWithRoutes(session, request, warn) {
	/** @type {Array<[string, () => Promise<Object>]>} */
	const routes = []

	// Route 1: native element playback. Offered only where the platform can
	// plausibly decode the manifest itself - native HLS support, or a plain
	// progressive file. DASH is never natively playable in a <video>.
	if (request.kind === "progressive" || canPlayMime("application/vnd.apple.mpegurl")) {
		routes.push(["native", () => captureViaNativeElement(session, request)])
	}

	// Route 2: MediaSource assembly. Viable for clear and AES-128 HLS; bails
	// by itself for Sample-AES (no sample-level decryptor ships in this
	// extension), for DASH, and for codecs the vendored transmuxer refuses.
	routes.push(["mse", () => captureViaMediaSource(session, request)])

	// Route 3: the source tab's own player, via the streamId the worker minted.
	if (request.streamId) routes.push(["tab", () => captureViaTab(session, request)])

	if (!routes.length) {
		throw new EngineError(
			FailureCode.ENGINE_UNAVAILABLE,
			"No playback route is available for this stream (no tab-capture streamId, and no in-document player)"
		)
	}

	/** @type {Array<string>} */
	const skipped = []
	let lastError = null
	for (const [name, run] of routes) {
		if (session.signal.aborted) throw new EngineError(FailureCode.CANCELLED, "Cancelled")
		try {
			log.info(`job ${session.jobId}: trying the ${name} playback route`)
			const result = await run()
			for (const reason of skipped) warn(reason)
			return result
		} catch (error) {
			if (error instanceof RouteFallback) {
				skipped.push(`the ${name} route cannot play this stream (${error.reason})`)
				continue
			}
			if (error instanceof EngineError && error.code === FailureCode.CANCELLED) throw error
			// A hard failure of one route (fetch refused, decode error) is
			// still worth trying the next route against: the tab's own player
			// sees a different network and decoder than we do.
			lastError = error
			skipped.push(`the ${name} route failed (${error?.message || error})`)
		}
	}

	throw (
		lastError ??
		new EngineError(FailureCode.UNSUPPORTED_CODEC, `No playback route could decode this stream: ${skipped.join("; ")}`)
	)
}

/* ================================================================== *
 * Route 1: native element playback
 * ================================================================== */

/**
 * Play the manifest (or plain file) directly in a hidden <video> and capture
 * the element. This is the only in-document route where the platform's own
 * player - and therefore its own Sample-AES support - does the decrypting.
 */
async function captureViaNativeElement(session, request) {
	const video = hiddenVideo()
	session.video = video

	try {
		video.src = request.manifestUrl

		// Playing before metadata arrives is deliberate: it is how a load
		// failure surfaces fast on a platform without native support.
		const playing = await startPlayback(session, video, "native")
		if (!playing) throw new RouteFallback("the element refused to play this URL")

		await Promise.race([once(video, "loadeddata", START_TIMEOUT_MS), once(video, "canplay", START_TIMEOUT_MS)])

		const stream = video.captureStream()
		if (!stream.getVideoTracks().length) throw new RouteFallback("the element produced no video track")

		const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : request.duration || null
		return await recordStream(session, stream, { video, durationTarget: duration, label: "native" })
	} finally {
		if (session.video === video) {
			session.video = null
			video.remove()
		}
	}
}

/* ================================================================== *
 * Route 2: MediaSource assembly (clear / AES-128 HLS)
 * ================================================================== */

/**
 * Rebuild playback the way the page's player would: parse the ladder, fetch
 * segments with the forwarded session (cookies via credentials, Referer/Origin
 * via the job's DNR rule), decrypt AES-128 transport encryption, transmux TS
 * to fMP4 with the vendored muxer, and feed a MediaSource. The recording then
 * captures the decoded output, exactly like route 1.
 *
 * Sample-AES bails before fetching a single segment: its TS packets carry no
 * scrambling flag, so nothing downstream would notice, and a "successful"
 * recording of undecrypted samples is the worst possible failure mode.
 */
async function captureViaMediaSource(session, request) {
	if (request.kind === "dash") {
		// The MPD parser's segment plans feed the file assembler, not a
		// MediaSource; multi-period DASH stays the companion host's job.
		throw new RouteFallback("DASH assembly for playback is not implemented")
	}

	const { signal } = session

	// Fetch and parse, then re-check the DRM gate against the manifest we
	// actually received - never against the extension's earlier reading of it.
	const first = await fetchText(request.manifestUrl, request.headers, signal)
	let parsed
	try {
		parsed = parsePlaylist(first.text, first.finalUrl)
	} catch (error) {
		throw new RouteFallback(`manifest did not parse (${error?.message || "not an HLS playlist"})`)
	}
	assertNotHardDrm(parsed.drm)

	let media = parsed
	let codecs = ""
	if (parsed.type === "master") {
		const variant = chooseVariant(parsed.variants, request.quality?.height || null)
		if (!variant) throw new RouteFallback("master playlist has no variants")
		codecs = variant.codecs || ""
		const sub = await fetchText(variant.url, request.headers, signal)
		media = parsePlaylist(sub.text, sub.finalUrl)
		// The key can be declared on the media playlist even when the master
		// read clean, so the gate runs again on what will actually be played.
		assertNotHardDrm(media.drm)
	}
	if (!media.segments?.length) throw new RouteFallback("playlist contains no segments")

	if (media.isLive) {
		session.warnings.add("Live playlist: the recording covers the currently published window only")
	}

	const mime = `video/mp4; codecs="${codecs || 'avc1.42E01E,mp4a.40.2'}"`
	if (!self.MediaSource?.isTypeSupported?.(mime)) {
		throw new RouteFallback(`MediaSource cannot play ${mime}`)
	}

	const video = hiddenVideo()
	session.video = video
	const source = new MediaSource()
	const objectUrl = URL.createObjectURL(source)
	video.src = objectUrl

	/** The recordStream promise, started as soon as frames are decodable. */
	let recording = null
	/** True once `recording` has been awaited or handed to the caller. */
	let recordingSettled = false

	try {
		await once(source, "sourceopen", START_TIMEOUT_MS)
		const buffer = source.addSourceBuffer(mime)

		// Serialized appends: appendBuffer during an update throws.
		let appendChain = Promise.resolve()
		const append = (bytes) => {
			appendChain = appendChain.then(
				() =>
					new Promise((resolve, reject) => {
						buffer.addEventListener("updateend", () => resolve(), { once: true })
						buffer.addEventListener("error", () => reject(new Error("SourceBuffer append failed")), { once: true })
						try {
							buffer.appendBuffer(bytes)
						} catch (error) {
							reject(error)
						}
					})
			)
			return appendChain
		}

		// Recording starts with playback, not with buffering - otherwise every
		// capture would cost (download time + full duration). Tied to `playing`
		// rather than `loadeddata` so a session that never actually plays fails
		// the route instead of recording a frozen first frame.
		const startRecording = () => {
			if (recording || session.signal.aborted) return
			const stream = video.captureStream()
			if (!stream.getVideoTracks().length) return
			const pending = recordStream(session, stream, {
				video,
				durationTarget: media.duration || request.duration || null,
				label: "mse",
				segmentsTotal: media.segments.length,
			})
			// Mark rejections as handled here so an abort between starting the
			// recording and awaiting it cannot raise an unhandled rejection.
			pending.catch(() => {})
			recording = pending
		}
		video.addEventListener("playing", startRecording, { once: true })
		video.addEventListener("timeupdate", startRecording)

		const transmuxer = new Transmuxer()
		const keyStore = new KeyStore({ signal })
		let initAppended = false

		for await (const { bytes } of fetchOrdered(media.segments, {
			concurrency: DEFAULT_CONCURRENCY,
			signal,
			keyStore,
		})) {
			transmuxer.push(bytes)
			const out = transmuxer.flush()
			if (out.fatal) throw new RouteFallback(out.fatal)
			if (out.initSegment && !initAppended) {
				await append(out.initSegment)
				initAppended = true
			}
			if (out.data?.byteLength) await append(out.data)

			// Begin playback as soon as there is anything to show.
			if (video.readyState >= 2 && video.paused) {
				await startPlayback(session, video, "mse")
			}

			session.segmentsDone += 1
		}

		const tail = transmuxer.flush({ final: true })
		if (tail.fatal) throw new RouteFallback(tail.fatal)
		if (tail.initSegment && !initAppended) await append(tail.initSegment)
		if (tail.data?.byteLength) await append(tail.data)

		if (!recording) throw new RouteFallback("no decodable frames were produced from the segments")

		try {
			if (source.readyState === "open") source.endOfStream()
		} catch {
			/* the element may already have ended */
		}

		recordingSettled = true
		return await recording
	} catch (error) {
		if (recording && !recordingSettled) recording.catch(() => {})
		throw error
	} finally {
		URL.revokeObjectURL(objectUrl)
		if (session.video === video) {
			session.video = null
			video.remove()
		}
	}
}

/* ================================================================== *
 * Route 3: the source tab's own player
 * ================================================================== */

/**
 * Record the tab the stream was detected on. The page's player - which is
 * what decrypted the Sample-AES stream in the first place - keeps playing;
 * this route records its decoded output. Needs the streamId the worker minted
 * with chrome.tabCapture before this session started.
 */
async function captureViaTab(session, request) {
	if (!request.streamId) throw new RouteFallback("no tab-capture streamId was provided")

	// Ask the worker to make the tab play (and to watch for its player
	// ending). The worker owns chrome.scripting; offscreen documents do not.
	let duration = Number(request.duration) || null
	try {
		const reply = await chrome.runtime.sendMessage({
			type: MSG.CAPTURE_PREPARE_TAB,
			target: Target.SERVICE_WORKER,
			jobId: session.jobId,
		})
		if (reply?.duration) duration = reply.duration
		if (reply && reply.found === false) {
			session.warnings.add("No video element was found playing in the source tab; recording whatever it renders")
		}
	} catch (error) {
		log.debug("tab prepare failed", error)
	}

	session.warnings.add(
		"Tab capture records the whole tab surface: keep it playing, audible and visible until the recording ends"
	)

	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: request.streamId } },
		video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: request.streamId } },
	})
	if (!stream.getTracks().length) throw new RouteFallback("the tab stream arrived empty")

	return await recordStream(session, stream, { durationTarget: duration, label: "tab" })
}

/* ================================================================== *
 * The recording core
 * ================================================================== */

/**
 * Record `stream` to disk until the timeline finishes, playback completes or
 * the session is stopped, then hand the assembled file to the worker.
 *
 * @param {Object} session
 * @param {MediaStream} stream
 * @param {{ video?: HTMLVideoElement|null, durationTarget?: number|null, label: string, segmentsTotal?: number }} options
 * @returns {Promise<{ url: string, size: number, filename: string }>}
 */
async function recordStream(session, stream, options) {
	const { video = null, durationTarget = null, label } = options
	if (typeof MediaRecorder === "undefined") {
		throw new EngineError(FailureCode.ENGINE_UNAVAILABLE, "MediaRecorder is unavailable in this browser")
	}

	const profile = RECORDER_MIME_LADDER.find((candidate) => {
		try {
			return MediaRecorder.isTypeSupported(candidate.mime)
		} catch {
			return false
		}
	})
	if (!profile) throw new EngineError(FailureCode.ENGINE_UNAVAILABLE, "No supported MediaRecorder container was found")

	// Match the source's declared bandwidth when known, so a 3 Mbps stream is
	// not re-encoded at a wasteful default and a 4K stream is not crushed.
	const declared = Number(session.quality?.bandwidth) || 0
	const videoBitsPerSecond = Math.min(25_000_000, Math.max(500_000, declared || 8_000_000))

	const sink = await OpfsRecordingSink.create(`capture-${session.jobId}.${profile.ext}`)
	session.sink = sink
	session.stream = stream

	const recorder = new MediaRecorder(stream, {
		mimeType: profile.mime,
		videoBitsPerSecond,
		audioBitsPerSecond: 128_000,
	})
	session.recorder = recorder

	const startedAt = performance.now()
	let lastMediaSeconds = 0
	let lastAdvanceAt = startedAt
	let bytesAtTick = 0
	let tickAt = startedAt

	const progressFor = (secondsOfMedia) => {
		const now = performance.now()
		const elapsed = (now - tickAt) / 1000
		const speed = elapsed > 0.2 ? Math.max(0, (session.bytes - bytesAtTick) / elapsed) : 0
		bytesAtTick = session.bytes
		tickAt = now
		const percent =
			durationTarget && durationTarget > 0
				? Math.max(0, Math.min(99, Math.round((secondsOfMedia / durationTarget) * 100)))
				: 0
		const etaSeconds =
			durationTarget && durationTarget > 0 && secondsOfMedia > 0
				? Math.max(0, Math.round(durationTarget - secondsOfMedia))
				: null
		void post({
			type: MSG.ENGINE_PROGRESS,
			target: Target.SERVICE_WORKER,
			jobId: session.jobId,
			phase: "recording",
			percent,
			bytesReceived: session.bytes,
			speed: Math.round(speed),
			etaSeconds,
			segmentsDone: session.segmentsDone ?? 0,
			segmentsTotal: options.segmentsTotal ?? 0,
		})
	}

	/**
	 * Graceful stop: resolve the completion promise, then stop the recorder so
	 * it can flush its final chunk before the sink is finalised.
	 */
	const stopSession = (reason) => {
		if (session.stopped) return
		session.stopped = true
		session.stopReason = reason
		log.info(`job ${session.jobId}: stopping (${reason})`)
		try {
			if (recorder.state !== "inactive") recorder.stop()
		} catch (error) {
			log.warn("recorder.stop threw", error)
		}
	}
	session.stop = stopSession

	recorder.ondataavailable = (event) => {
		if (event.data?.size) {
			session.bytes += event.data.size
			sink.write(event.data).catch((error) => log.warn("chunk write failed", error))
		}
	}
	recorder.onerror = (event) => {
		log.error("MediaRecorder error", event?.error)
		session.warnings.add(`Recorder trouble: ${event?.error?.message || "unknown MediaRecorder error"}`)
	}

	// Natural completion: the play head ran off the end of the timeline.
	if (video) video.addEventListener("ended", () => stopSession("playback completed"), { once: true })
	// Tab capture tracks end when the tab closes, navigates or stops capture.
	for (const track of stream.getTracks()) {
		track.addEventListener("ended", () => stopSession("stream ended"), { once: true })
	}

	recorder.start(TICK_MS)
	log.info(`job ${session.jobId}: recording via ${label} into ${profile.ext}`)

	// Watchdogs and progress, alive for exactly as long as the recording.
	const tick = setInterval(() => {
		if (session.stopped) return
		const recordedSeconds = (performance.now() - startedAt) / 1000

		if (video) {
			const current = video.currentTime
			if (current > lastMediaSeconds + 0.05) {
				lastMediaSeconds = current
				lastAdvanceAt = performance.now()
			} else if (performance.now() - lastAdvanceAt > STALL_TIMEOUT_MS) {
				session.warnings.add("Playback stalled; finalising the recording at the stall point")
				stopSession("stalled")
				return
			}
			progressFor(lastMediaSeconds)
		} else {
			// No play head exists for a tab capture; wall clock stands in.
			progressFor(recordedSeconds)
		}

		// Bound the session. A known duration gets generous slack, because a
		// paused player in the tab should not truncate the capture; an unknown
		// one gets the hard cap.
		if (durationTarget && recordedSeconds > durationTarget * 1.25 + END_GRACE_SECONDS) {
			session.warnings.add("Recording ran past the expected runtime; finalising")
			stopSession("duration exceeded")
		} else if (!durationTarget && recordedSeconds > HARD_CAP_SECONDS) {
			session.warnings.add("Recording hit the open-ended capture limit; finalising")
			stopSession("hard cap")
		}
	}, TICK_MS)

	const completion = new Promise((resolve) => {
		const poll = () => (session.stopped ? resolve(session.stopReason) : setTimeout(poll, 100))
		poll()
	})
	const cancellation = new Promise((_, reject) => {
		session.signal.addEventListener(
			"abort",
			() => reject(new EngineError(FailureCode.CANCELLED, "Cancelled")),
			{ once: true }
		)
	})

	try {
		await Promise.race([completion, cancellation])
	} finally {
		clearInterval(tick)
	}

	// Wait for the final chunk to land before closing the sink. The recorder
	// fires dataavailable-then-stop; a hard 5s backstop covers a wedged stop.
	if (recorder.state !== "inactive") {
		await Promise.race([once(recorder, "stop", 5_000).catch(() => {}), delay(5_000)])
	}

	const { url, size } = await sink.finalize()
	if (!size) throw new EngineError(FailureCode.SEGMENT_FAILED, "The recording was empty")

	const filename = outputFilename(session, profile.ext)
	finished.set(session.jobId, { sink, filename })
	sessions.delete(session.jobId)
	await teardownSession(session, { discardSink: false })

	log.info(`job ${session.jobId} recorded ${humanBytes(size)} -> ${filename}`)
	await post({
		type: MSG.ENGINE_RESULT,
		target: Target.SERVICE_WORKER,
		jobId: session.jobId,
		ok: true,
		blobUrl: url,
		size,
		filename,
		warnings: [...session.warnings],
	})
	return { url, size, filename }
}

/**
 * Assemble the final filename from the name the job promised, with the
 * extension of the container that was actually recorded.
 *
 * @param {Object} session
 * @param {string} ext
 */
function outputFilename(session, ext) {
	const requested = String(session.filename || "")
	const stem = requested.replace(/\.[a-z0-9]{1,5}$/i, "").trim() || "recording"
	return `${stem}.${ext}`
}

/**
 * Stop tracks, detach the video element, and (optionally) drop the sink.
 *
 * @param {Object} session
 * @param {{ discardSink: boolean }} options
 */
async function teardownSession(session, { discardSink }) {
	try {
		session.stream?.getTracks().forEach((track) => track.stop())
	} catch {
		/* already stopped */
	}
	if (session.video) {
		try {
			session.video.pause()
			session.video.removeAttribute("src")
			session.video.load()
		} catch {
			/* already torn down */
		}
		session.video.remove()
		session.video = null
	}
	if (discardSink && session.sink) {
		await session.sink.abort().catch(() => {})
		session.sink = null
	}
}

/* ================================================================== *
 * Message handling
 *
 * Same contract as the strategy A engine: only messages addressed to the
 * offscreen document are answered, or this listener would win the race for
 * replies meant for the popup or the worker.
 * ================================================================== */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.target !== Target.OFFSCREEN) return undefined

	switch (message.type) {
		case MSG.ENGINE_PING:
			sendResponse({ ok: true, recorder: true, sessions: [...sessions.keys()] })
			return false

		case MSG.CAPTURE_RUN:
			// Acknowledge immediately; outcomes arrive via ENGINE_RESULT. A
			// recording runs for as long as the stream does, which is far too
			// long to hold a sendMessage channel open.
			void runSession(message).catch(async (error) => {
				const mapped = toEngineError(error)
				await post({
					type: MSG.ENGINE_RESULT,
					target: Target.SERVICE_WORKER,
					jobId: message.jobId,
					ok: false,
					code: mapped.code,
					message: mapped.message,
					retryable: false,
				})
			})
			sendResponse({ ok: true, accepted: true })
			return false

		case MSG.ENGINE_CANCEL: {
			const session = sessions.get(message.jobId)
			if (!session) {
				sendResponse({ ok: true, cancelled: false })
				return false
			}
			if (message.finalize) {
				// The tab's own player finished; keep everything recorded so far.
				session.stop?.("the source tab finished playing")
				sendResponse({ ok: true, finalized: true })
			} else {
				session.controller.abort()
				sendResponse({ ok: true, cancelled: true })
			}
			return false
		}

		case MSG.ENGINE_RELEASE: {
			const entry = finished.get(message.jobId)
			finished.delete(message.jobId)
			void entry?.sink.release()
			sendResponse({ ok: true })
			return false
		}

		default:
			return undefined
	}
})

log.info("offscreen recorder ready")
