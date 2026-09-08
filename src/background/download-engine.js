/**
 * Download engine: job lifecycle and the Strategy A -> Strategy B cascade.
 *
 * Strategy A runs in an offscreen document (fetch, decrypt, remux, write).
 * Strategy B hands the job to a local ffmpeg process through the companion
 * host. This module decides which is in play, tracks progress, and reports to
 * the popup.
 *
 * It deliberately does no media work itself - the service worker that imports
 * it can be evicted at any moment, so everything durable lives elsewhere and
 * everything stateful is persisted.
 *
 * @module background/download-engine
 */

import { MSG, Target, FailureCode, EngineError, broadcast } from "../shared/messages.js"
import { Strategy, safeFilename, qualityLabel, isCaptureEligible, SAMPLE_AES_SCHEME } from "../shared/media-types.js"
import * as registry from "./media-registry.js"
import { applyRefererRule, removeRules } from "./net-rules.js"
import {
	probeCompanion,
	buildCompanionPayload,
	runCompanionDownload,
	cancelCompanionDownload,
	CompanionState,
} from "./companion.js"
import { createLogger } from "../shared/logger.js"

const log = createLogger("engine")

const OFFSCREEN_URL = "src/offscreen/offscreen.html"
const RECORDER_URL = "src/offscreen/recorder.html"
const STORAGE_KEY = "jobs:v1"

export const JobState = Object.freeze({
	PREPARING: "preparing",
	RUNNING: "running",
	MUXING: "muxing",
	SAVING: "saving",
	DONE: "done",
	FAILED: "failed",
	CANCELLED: "cancelled",
})

const ACTIVE_STATES = new Set([JobState.PREPARING, JobState.RUNNING, JobState.MUXING, JobState.SAVING])

/* ================================================================== *
 * Persisted job records
 *
 * The worker that starts a job is usually not the worker that finishes it:
 * MV3 evicts it after ~30s idle and a download runs for minutes. An incoming
 * ENGINE_RESULT revives the worker, but only a persisted record can tell the
 * revived worker what that jobId was for.
 * ================================================================== */

/** @type {Record<string, Object>|null} */
let jobCache = null

async function loadJobs() {
	if (jobCache) return jobCache
	const stored = await chrome.storage.session.get(STORAGE_KEY)
	jobCache = stored?.[STORAGE_KEY] ?? {}
	return jobCache
}

async function persist() {
	if (!jobCache) return
	try {
		await chrome.storage.session.set({ [STORAGE_KEY]: jobCache })
	} catch (error) {
		log.warn("could not persist job state", error)
	}
}

/** @param {string} jobId */
async function getJob(jobId) {
	const jobs = await loadJobs()
	return jobs[jobId] ?? null
}

/**
 * @param {string} jobId
 * @param {Object} patch
 */
async function updateJob(jobId, patch) {
	const jobs = await loadJobs()
	const existing = jobs[jobId]
	if (!existing) return null
	const next = { ...existing, ...patch }
	jobs[jobId] = next
	await persist()
	return next
}

/**
 * In-memory only, and unavoidably so: an AbortController cannot be serialised.
 * After a worker restart these are gone, and cancelling a Strategy B job
 * degrades to a best-effort message to the native port.
 * @type {Map<string, AbortController>}
 */
const controllers = new Map()

/** downloadId -> jobId, for the onChanged listener. */
/** @type {Map<number, string>} */
const downloadToJob = new Map()

/* ================================================================== *
 * Offscreen document lifecycle
 *
 * Chrome allows exactly one offscreen document per extension, and the engine
 * (offscreen.html, reason BLOBS) and the recorder (recorder.html, reason
 * USER_MEDIA) need different documents. Every helper below therefore treats
 * the open document as a slot to be claimed or released, never assumes which
 * page is loaded in it, and refuses to evict a document that is still serving
 * an active job.
 * ================================================================== */

/** @type {Promise<void>|null} */
let creating = null
/** @type {Promise<void>|null} */
let creatingRecorder = null

/**
 * @param {string} [documentUrl] match only a document served from this URL;
 *   omit it to ask about any offscreen document at all.
 */
async function offscreenExists(documentUrl) {
	if (!chrome.runtime.getContexts) return false
	const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })
	if (!documentUrl) return contexts.length > 0
	return contexts.some((context) => String(context.documentUrl || "").endsWith(documentUrl))
}

/**
 * Create the engine document if it is not already up.
 *
 * Only one offscreen document may exist per extension, and two jobs started in
 * the same tick would both try to create it, so creation is funnelled through a
 * single promise and the "already exists" rejection is treated as success.
 */
async function ensureOffscreen() {
	if (await offscreenExists(OFFSCREEN_URL)) return

	// The slot may be occupied by the recorder. An idle one is replaced; a busy
	// one is not, and the caller fails with ENGINE_UNAVAILABLE - which the
	// cascade answers by escalating to the companion host, exactly the right
	// remedy for "cannot run the in-browser engine right now".
	if (await offscreenExists()) {
		if (await hasActiveCaptureJobs()) {
			throw new EngineError(
				FailureCode.ENGINE_UNAVAILABLE,
				"The offscreen recorder is busy with a live capture; try again once it finishes"
			)
		}
		try {
			await chrome.offscreen.closeDocument()
		} catch {
			/* closing a document that is already gone is fine */
		}
	}

	if (creating) {
		await creating
		return
	}

	creating = chrome.offscreen
		.createDocument({
			url: OFFSCREEN_URL,
			reasons: ["BLOBS"],
			justification:
				"Fetch, decrypt and remux media segments, and hold the assembled file until the browser has saved it.",
		})
		.catch(async (error) => {
			// Lost the race with a concurrent call: that is fine.
			if (await offscreenExists(OFFSCREEN_URL)) return
			throw error
		})

	try {
		await creating
	} finally {
		creating = null
	}
}

/**
 * Create the offscreen *recorder* document (strategy C) if it is not already
 * up. The reasons and justification matter: MV3 requires them, and USER_MEDIA
 * is the declared category for a document whose whole job is to own a
 * MediaRecorder fed from `getUserMedia` / `captureStream`.
 */
async function ensureRecorderDocument() {
	if (await offscreenExists(RECORDER_URL)) return

	// Claim the single-document slot from an idle engine document. A busy one
	// is never evicted: tearing it down mid-download would kill another job's
	// in-flight assembly.
	if (await offscreenExists()) {
		if (await hasActiveBrowserJobs()) {
			throw new EngineError(
				FailureCode.ENGINE_UNAVAILABLE,
				"The in-browser engine is busy with another download; retry the recording once it finishes"
			)
		}
		try {
			await chrome.offscreen.closeDocument()
		} catch {
			/* closing a document that is already gone is fine */
		}
	}

	if (creatingRecorder) {
		await creatingRecorder
		return
	}

	creatingRecorder = chrome.offscreen
		.createDocument({
			url: RECORDER_URL,
			reasons: ["USER_MEDIA"],
			justification: "Recording decrypted streaming layers",
		})
		.catch(async (error) => {
			if (await offscreenExists(RECORDER_URL)) return
			throw error
		})

	try {
		await creatingRecorder
	} finally {
		creatingRecorder = null
	}
}

/** @param {Object} message */
async function sendToOffscreen(message) {
	await ensureOffscreen()
	return chrome.runtime.sendMessage({ ...message, target: Target.OFFSCREEN })
}

/**
 * @param {Object} message
 * Like sendToOffscreen, but for the recorder document. The recorder speaks the
 * same ENGINE_* protocol (progress, result, release, cancel) for everything
 * after the initial CAPTURE_RUN, so only the document address differs.
 */
async function sendToRecorder(message) {
	await ensureRecorderDocument()
	return chrome.runtime.sendMessage({ ...message, target: Target.OFFSCREEN })
}

/** Whether any job is mid-capture; such a job owns the recorder document. */
async function hasActiveCaptureJobs() {
	const jobs = await loadJobs()
	return Object.values(jobs).some((job) => job.state === JobState.RUNNING && job.strategy === Strategy.CAPTURE)
}

/** Whether any job is mid-Strategy-A; such a job owns the engine document. */
async function hasActiveBrowserJobs() {
	const jobs = await loadJobs()
	return Object.values(jobs).some((job) => ACTIVE_STATES.has(job.state) && job.strategy === Strategy.BROWSER)
}

/** Close whichever offscreen document is open once nothing needs it, to release its memory. */
async function maybeCloseOffscreen() {
	const jobs = await loadJobs()
	const busy = Object.values(jobs).some((job) => ACTIVE_STATES.has(job.state))
	if (busy || downloadToJob.size) return

	if (!(await offscreenExists())) return
	try {
		await chrome.offscreen.closeDocument()
	} catch {
		/* nothing depends on this succeeding */
	}
}

/* ================================================================== *
 * Reporting
 * ================================================================== */

/** @param {Object} job */
function publicView(job) {
	return {
		jobId: job.jobId,
		tabId: job.tabId,
		entryId: job.entryId,
		variantIndex: job.variantIndex,
		filename: job.filename,
		state: job.state,
		strategy: job.strategy,
		phase: job.phase ?? null,
		percent: job.percent ?? 0,
		bytesReceived: job.bytesReceived ?? 0,
		speed: job.speed ?? 0,
		etaSeconds: job.etaSeconds ?? null,
		segmentsDone: job.segmentsDone ?? 0,
		segmentsTotal: job.segmentsTotal ?? 0,
		size: job.size ?? null,
		path: job.path ?? null,
		code: job.code ?? null,
		message: job.message ?? null,
		warnings: job.warnings ?? [],
	}
}

/** @param {Object} job */
async function reportProgress(job) {
	await broadcast({ type: MSG.JOB_PROGRESS, job: publicView(job) })
}

/**
 * @param {Object} job
 * @param {{ code: string, message: string }} failure
 */
async function finishFailed(job, failure) {
	const state = failure.code === FailureCode.CANCELLED ? JobState.CANCELLED : JobState.FAILED
	const next = await updateJob(job.jobId, { state, code: failure.code, message: failure.message })
	await releaseJobResources(job)
	log.warn(`job ${job.jobId} ${state}: ${failure.code} - ${failure.message}`)
	await broadcast({ type: MSG.JOB_ERROR, job: publicView(next ?? { ...job, ...failure, state }) })
	await maybeCloseOffscreen()
}

/** @param {Object} job */
async function finishDone(job) {
	const next = await updateJob(job.jobId, { state: JobState.DONE, percent: 100 })
	await releaseJobResources(job)
	log.info(`job ${job.jobId} done -> ${job.filename}`)
	await broadcast({ type: MSG.JOB_DONE, job: publicView(next ?? { ...job, state: JobState.DONE }) })
	await maybeCloseOffscreen()
}

/**
 * Drop the DNR header rule and the cancellation handle for a finished job.
 * @param {Object} job
 */
async function releaseJobResources(job) {
	controllers.delete(job.jobId)
	if (Number.isInteger(job.ruleId)) {
		try {
			await removeRules([job.ruleId])
		} catch (error) {
			log.debug("could not remove header rule", error)
		}
		await updateJob(job.jobId, { ruleId: null })
	}
}

/* ================================================================== *
 * Starting a job
 * ================================================================== */

/**
 * Begin a segmented download.
 *
 * @param {{ tabId: number, entryId: string, variantIndex?: number }} args
 */
export async function startJob({ tabId, entryId, variantIndex = 0 }) {
	const entry = await registry.get(tabId, entryId)
	if (!entry) {
		return { ok: false, code: FailureCode.UNKNOWN, message: "That item is no longer available." }
	}

	// Enforced here as well as in the UI and the offscreen engine. A refusal
	// that only exists in one layer is a refusal that can be routed around.
	// Sample-AES is the one deliberate exception: it is capture-eligible, and
	// the job is routed to the companion host, whose own manifest inspection
	// decides between `requires_capture` (strategy C) and a hard DRM refusal.
	if (entry.drm?.protected && !isCaptureEligible(entry)) {
		return {
			ok: false,
			code: FailureCode.DRM_PROTECTED,
			message: `This stream is ${entry.drm.scheme}-protected and is not supported.`,
		}
	}

	const jobs = await loadJobs()

	// Re-clicking a running rendition should not start a second job.
	const duplicate = Object.values(jobs).find(
		(job) =>
			job.entryId === entryId && job.variantIndex === variantIndex && ACTIVE_STATES.has(job.state)
	)
	if (duplicate) return { ok: true, jobId: duplicate.jobId, segmented: true, strategy: duplicate.strategy }

	const variant = entry.variants?.[variantIndex] ?? null
	const suffix = variant?.height ? qualityLabel(variant.width, variant.height) : ""
	const filename = safeFilename(entry.pageTitle || entry.title || "video", suffix, "mp4")

	const jobId = crypto.randomUUID()

	// Many segment CDNs reject a request with no Referer, and the extension's
	// own fetches send none. net-rules scopes this to tabIds [-1], so only
	// extension traffic is rewritten - never the page's own requests.
	let ruleId = null
	try {
		ruleId = await applyRefererRule(new URL(entry.url).host, entry.pageUrl)
	} catch (error) {
		log.debug("could not install header rule", error)
	}

	/** @type {Object} */
	const job = {
		jobId,
		tabId,
		entryId,
		variantIndex,
		filename,
		state: JobState.PREPARING,
		strategy: Strategy.BROWSER,
		phase: "preparing",
		percent: 0,
		bytesReceived: 0,
		speed: 0,
		etaSeconds: null,
		segmentsDone: 0,
		segmentsTotal: 0,
		ruleId,
		triedCompanion: false,
		warnings: [],
		startedAt: Date.now(),
	}

	jobs[jobId] = job
	await persist()
	await reportProgress(job)

	// Sample-AES cannot be handled by Strategy A at all: the in-browser engine
	// refuses protected playlists rather than assembling undecryptable bytes.
	// Skip straight to the companion host, which fetches the manifest itself
	// and answers with either the capture handoff or a hard DRM refusal. (When
	// the companion is missing, escalate still routes to the recorder.)
	if (isCaptureEligible(entry)) {
		void escalate(job, {
			code: FailureCode.DRM_PROTECTED,
			message: "Sample-AES stream; asking the companion host to route it",
			scheme: SAMPLE_AES_SCHEME,
		})
		return { ok: true, jobId, segmented: true, filename, strategy: Strategy.CAPTURE }
	}

	try {
		await sendToOffscreen({
			type: MSG.ENGINE_RUN,
			jobId,
			filename,
			variantIndex,
			entry: {
				url: entry.url,
				kind: entry.kind,
				pageUrl: entry.pageUrl,
				title: entry.title,
				drm: entry.drm ?? null,
			},
		})
		await updateJob(jobId, { state: JobState.RUNNING, phase: "fetching" })
	} catch (error) {
		// The engine document could not even be started. That is precisely the
		// kind of environment problem the companion exists for.
		log.warn("offscreen engine unavailable", error)
		void escalate(job, {
			code: FailureCode.ENGINE_UNAVAILABLE,
			message: error?.message || "The in-browser engine could not be started",
		})
	}

	return { ok: true, jobId, segmented: true, filename, strategy: Strategy.BROWSER }
}

/* ================================================================== *
 * Messages from the offscreen engine
 * ================================================================== */

/**
 * @param {Object} message
 * @returns {Promise<Object>}
 */
export async function handleEngineMessage(message) {
	switch (message.type) {
		case MSG.ENGINE_PROGRESS: {
			const job = await getJob(message.jobId)
			if (!job || !ACTIVE_STATES.has(job.state)) return { ok: true }

			const state =
				message.phase === "muxing"
					? JobState.MUXING
					: message.phase === "saving"
						? JobState.SAVING
						: JobState.RUNNING

			const next = await updateJob(message.jobId, {
				state,
				phase: message.phase,
				percent: message.percent ?? job.percent,
				bytesReceived: message.bytesReceived ?? job.bytesReceived,
				speed: message.speed ?? 0,
				etaSeconds: message.etaSeconds ?? null,
				segmentsDone: message.segmentsDone ?? job.segmentsDone,
				segmentsTotal: message.segmentsTotal ?? job.segmentsTotal,
			})
			if (next) await reportProgress(next)
			return { ok: true }
		}

		case MSG.ENGINE_RESULT: {
			const job = await getJob(message.jobId)
			if (!job) {
				log.debug(`result for unknown job ${message.jobId}`)
				return { ok: true }
			}

			if (message.warnings?.length) {
				await updateJob(job.jobId, { warnings: message.warnings })
			}

			if (message.ok) {
				await saveAssembledFile(job, message)
				return { ok: true }
			}

			await handleStrategyAFailure(job, message)
			return { ok: true }
		}

		default:
			return { ok: false, code: FailureCode.UNKNOWN, message: `Unhandled engine message ${message.type}` }
	}
}

/**
 * Tell whichever offscreen document produced a finished file that it may drop
 * it. The document address matters: a capture job's blob lives in the
 * recorder, and releasing it through sendToOffscreen would evict the recorder
 * document to spin up the engine page instead.
 *
 * @param {Object|null} job
 * @param {string} jobId
 */
async function releaseOffscreenOutput(job, jobId) {
	try {
		if (job?.strategy === Strategy.CAPTURE) {
			if (await offscreenExists(RECORDER_URL)) {
				await chrome.runtime.sendMessage({ type: MSG.ENGINE_RELEASE, jobId, target: Target.OFFSCREEN })
			}
		} else {
			await sendToOffscreen({ type: MSG.ENGINE_RELEASE, jobId })
		}
	} catch {
		/* the document may already be gone; its blobs die with it */
	}
}

/**
 * Hand the assembled blob to chrome.downloads.
 *
 * @param {Object} job
 * @param {{ blobUrl: string, size: number, filename: string }} result
 */
async function saveAssembledFile(job, result) {
	await updateJob(job.jobId, { state: JobState.SAVING, phase: "saving", size: result.size, percent: 100 })

	try {
		const downloadId = await chrome.downloads.download({
			url: result.blobUrl,
			filename: result.filename || job.filename,
			saveAs: false,
		})

		// download() resolves when the item is *created*, not when its bytes have
		// been read. Revoking the blob URL here would cancel the transfer, so the
		// offscreen document keeps the file until onChanged says otherwise.
		downloadToJob.set(downloadId, job.jobId)
		await updateJob(job.jobId, { downloadId })
	} catch (error) {
		await releaseOffscreenOutput(job, job.jobId)
		await finishFailed(job, {
			code: FailureCode.UNKNOWN,
			message: error?.message || "The browser refused to save the assembled file",
		})
	}
}

chrome.downloads.onChanged.addListener(async (delta) => {
	const jobId = downloadToJob.get(delta.id)
	if (!jobId) return

	const current = delta.state?.current
	if (current !== "complete" && current !== "interrupted") return

	downloadToJob.delete(delta.id)
	const job = await getJob(jobId)
	if (!job) return

	// Only now is it safe to revoke the blob URL and delete the temp file -
	// addressed to whichever document produced the output.
	await releaseOffscreenOutput(job, jobId)

	if (current === "complete") {
		await finishDone(job)
	} else {
		await finishFailed(job, {
			code: FailureCode.UNKNOWN,
			message: delta.error?.current || "The browser interrupted the save",
		})
	}
})

/* ================================================================== *
 * The cascade
 * ================================================================== */

/**
 * Decide whether a Strategy A failure is worth escalating.
 *
 * @param {Object} job
 * @param {{ code: string, message: string, retryable?: boolean, scheme?: string|null }} failure
 */
async function handleStrategyAFailure(job, failure) {
	if (failure.code === FailureCode.CANCELLED) {
		await finishFailed(job, failure)
		return
	}

	// Hard DRM is terminal by construction: retrying a protected stream through
	// ffmpeg would turn Strategy B into a bypass for the refusal Strategy A
	// enforces.
	if (failure.code === FailureCode.DRM_PROTECTED && failure.scheme !== SAMPLE_AES_SCHEME) {
		await finishFailed(job, failure)
		return
	}

	// Sample-AES is exempt from the retryable===false rule that makes a DRM
	// refusal terminal, and from the scheme check above: Strategy A refused it
	// without downloading anything (there is no sample-level decryptor to
	// bypass), and the companion host does not decrypt it either - it routes
	// the job to the offscreen recorder. The host makes that call from its own
	// manifest inspection, so escalating here hands the decision to the layer
	// equipped to make it.
	if (failure.code === FailureCode.DRM_PROTECTED && failure.scheme === SAMPLE_AES_SCHEME && !job.triedCompanion) {
		await escalate(job, failure)
		return
	}

	if (failure.retryable === false || job.triedCompanion) {
		await finishFailed(job, failure)
		return
	}

	await escalate(job, failure)
}

/**
 * Strategy B: run the job through the native companion host.
 *
 * @param {Object} job
 * @param {{ code: string, message: string }} reason why Strategy A failed
 */
async function escalate(job, reason) {
	log.info(`escalating job ${job.jobId} to the companion host (${reason.code})`)

	const entry = await registry.get(job.tabId, job.entryId)
	if (!entry) {
		await finishFailed(job, { code: FailureCode.UNKNOWN, message: "That item is no longer available." })
		return
	}

	const probe = await probeCompanion()
	if (probe.state !== CompanionState.READY) {
		// No host to authorise a capture handoff - but if the extension's own
		// probe already flagged the stream as Sample-AES, route it to the
		// recorder anyway rather than dead-ending the job. The recorder
		// re-fetches and re-parses the manifest before recording anything, so
		// hard DRM still cannot slip through on the extension's say-so alone.
		if (isCaptureEligible(entry)) {
			log.info(`companion unavailable; routing sample-aes job ${job.jobId} straight to the recorder`)
			try {
				const payload = await buildCompanionPayload({
					jobId: job.jobId,
					entry,
					variant: entry.variants?.[job.variantIndex] ?? null,
					filename: job.filename,
					duration: entry.duration,
				})
				await startCaptureHandoff(job, payload, entry)
			} catch (error) {
				await finishFailed(job, {
					code: error instanceof EngineError ? error.code : FailureCode.UNKNOWN,
					message: error?.message || "The capture handoff could not be prepared",
				})
			}
			return
		}

		// Report the original Strategy A failure as the cause, with the companion
		// as the remedy - that is the actionable framing.
		await finishFailed(job, {
			code: probe.state === CompanionState.NO_FFMPEG ? FailureCode.COMPANION_MISSING : FailureCode.COMPANION_MISSING,
			message:
				probe.state === CompanionState.NO_FFMPEG
					? `In-browser download failed (${reason.message}). The companion host is installed but cannot find ffmpeg.`
					: `In-browser download failed (${reason.message}). Install the companion host to use ffmpeg instead.`,
		})
		return
	}

	const updated = await updateJob(job.jobId, {
		strategy: Strategy.COMPANION,
		triedCompanion: true,
		state: JobState.RUNNING,
		phase: "companion",
		percent: 0,
		bytesReceived: 0,
		speed: 0,
	})
	if (updated) await reportProgress(updated)

	const controller = new AbortController()
	controllers.set(job.jobId, controller)

	/** The companion payload; also the payload the recorder inherits on handoff. */
	let payload = null

	try {
		payload = await buildCompanionPayload({
			jobId: job.jobId,
			entry,
			variant: entry.variants?.[job.variantIndex] ?? null,
			filename: job.filename,
			duration: entry.duration,
		})

		const result = await runCompanionDownload({
			payload,
			signal: controller.signal,
			onProgress: (progress) => void relayCompanionProgress(job.jobId, progress),
		})

		const done = await updateJob(job.jobId, {
			path: result.path,
			size: result.size,
			warnings: [...(job.warnings ?? []), ...result.warnings],
		})
		await finishDone(done ?? job)
	} catch (error) {
		// The host inspected the manifest, found Sample-AES, and answered with
		// the specialised capture state. This is a routing decision, not a
		// failure: the job continues in the offscreen recorder with the same
		// payload (manifest link, cookies, referer and auth headers) it would
		// have been downloaded with.
		if (error instanceof EngineError && error.code === FailureCode.REQUIRES_CAPTURE && payload) {
			controllers.delete(job.jobId)
			await startCaptureHandoff(job, payload, entry)
			return
		}

		const mapped =
			error instanceof EngineError
				? error
				: new EngineError(FailureCode.COMPANION_FAILED, error?.message || "The companion host failed")
		await finishFailed(job, { code: mapped.code, message: mapped.message })
	}
}

/* ================================================================== *
 * Strategy C: the offscreen capture handoff
 * ================================================================== */

/**
 * Hand a job to the offscreen recorder (src/offscreen/recorder.html).
 *
 * The payload is the same one the companion host was given - manifest link,
 * cookies, referer and page authentication headers - so the recorder fetches
 * the stream as the authorised session, plays it through the browser's own
 * media stack, and records the decoded (i.e. already-decrypted) output.
 *
 * @param {Object} job
 * @param {Object} payload the companion payload (manifestUrl, headers, ...)
 * @param {Object} entry the registry entry, for page context
 */
async function startCaptureHandoff(job, payload, entry) {
	log.info(`routing job ${job.jobId} to the offscreen recorder`)

	const updated = await updateJob(job.jobId, {
		strategy: Strategy.CAPTURE,
		triedCompanion: true,
		state: JobState.RUNNING,
		phase: "recording",
		percent: 0,
		bytesReceived: 0,
		speed: 0,
		etaSeconds: null,
	})
	if (updated) await reportProgress(updated)

	// The tab-capture streamId is acquired here because chrome.tabCapture does
	// not exist inside offscreen documents - only the service worker can mint
	// one. Best effort: the recorder has routes that do not need it, and if
	// none work it reports a precise failure.
	let streamId = null
	if (Number.isInteger(job.tabId) && chrome.tabCapture?.getMediaStreamId) {
		try {
			streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: job.tabId })
		} catch (error) {
			log.debug("tab capture streamId unavailable", error)
		}
	}

	try {
		await sendToRecorder({
			type: MSG.CAPTURE_RUN,
			jobId: job.jobId,
			manifestUrl: payload.manifestUrl,
			kind: payload.kind ?? null,
			filename: job.filename,
			headers: payload.headers ?? {},
			duration: payload.duration ?? entry.duration ?? null,
			quality: payload.quality ?? null,
			tabId: job.tabId,
			streamId,
			pageUrl: entry.pageUrl ?? null,
			title: entry.title ?? entry.pageTitle ?? null,
		})
	} catch (error) {
		await finishFailed(job, {
			code: FailureCode.ENGINE_UNAVAILABLE,
			message: error?.message || "The offscreen recorder could not be started",
		})
	}
}

/**
 * Make the source tab actually play the stream, and watch for it ending.
 * Requested by the recorder when it falls back to tab capture: the tab's own
 * player is the thing decrypting a Sample-AES stream, so playback has to run
 * for there to be anything to record.
 *
 * @param {string} jobId
 */
export async function prepareTabForCapture(jobId) {
	const job = await getJob(jobId)
	if (!job || !Number.isInteger(job.tabId) || !chrome.scripting?.executeScript) {
		return { ok: false, found: false, duration: null }
	}

	// The player frequently lives in an embed iframe (it does on Kinescope), so
	// every frame gets the nudge and the first one with a video element wins.
	let results = []
	try {
		results = await chrome.scripting.executeScript({
			target: { tabId: job.tabId, allFrames: true },
			func: nudgeTabPlayback,
			args: [jobId],
		})
	} catch (error) {
		log.debug("could not reach the source tab", error)
		return { ok: false, found: false, duration: null }
	}

	for (const injection of results ?? []) {
		if (injection?.result?.found) {
			return { ok: true, found: true, duration: injection.result.duration || null }
		}
	}
	return { ok: true, found: false, duration: null }
}

/**
 * Runs inside the source tab (all frames). Deliberately self-contained:
 * chrome.scripting serialises this function's source, so it may not reference
 * anything from module scope. Registered at the top level for the same reason.
 *
 * @param {string} jobId
 */
function nudgeTabPlayback(jobId) {
	const videos = Array.from(document.querySelectorAll("video"))
	const pick = videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
	if (!pick) return { found: false, duration: null }

	// Capture records what the tab renders, so a paused player means a frozen
	// recording. Starting it is best effort - autoplay refusal is possible.
	if (pick.paused) {
		try {
			const p = pick.play()
			if (p && typeof p.catch === "function") p.catch(() => {})
		} catch {
			/* autoplay policies; nothing more this can do */
		}
	}

	// Replace any watcher from a previous attempt, then notify the worker when
	// the tab's own player finishes. The literal matches MSG.CAPTURE_TAB_ENDED.
	if (window.__ovdCaptureWatch) {
		for (const off of window.__ovdCaptureWatch) {
			try {
				off()
			} catch {
				/* already detached */
			}
		}
	}
	const onEnded = () => {
		try {
			// The literal matches MSG.CAPTURE_TAB_ENDED. The rejection is caught
			// because this runs in the page long after anyone is listening for
			// errors, and the recorder's own timers bound the session anyway.
			const sent = chrome.runtime.sendMessage({ type: "capture:tab-ended", jobId })
			if (sent && typeof sent.catch === "function") sent.catch(() => {})
		} catch {
			/* the worker may be asleep; the recorder's own timers bound the session */
		}
	}
	pick.addEventListener("ended", onEnded)
	window.__ovdCaptureWatch = [() => pick.removeEventListener("ended", onEnded)]

	return { found: true, duration: Number.isFinite(pick.duration) ? pick.duration : null }
}

/**
 * Ask the recorder to stop a session. `finalize` keeps what has been recorded
 * so far; without it the session is discarded as a cancellation.
 *
 * @param {string} jobId
 * @param {{ finalize?: boolean }} [options]
 */
export async function requestCaptureStop(jobId, { finalize = false } = {}) {
	if (!(await offscreenExists(RECORDER_URL))) return { ok: true, stopped: false }
	try {
		await chrome.runtime.sendMessage({
			type: MSG.ENGINE_CANCEL,
			jobId,
			finalize,
			target: Target.OFFSCREEN,
		})
		return { ok: true, stopped: true }
	} catch (error) {
		log.debug("could not reach the recorder", error)
		return { ok: false, stopped: false }
	}
}

/**
 * @param {string} jobId
 * @param {{ percent?: number, bytes?: number, speed?: number, seconds?: number, etaSeconds?: number }} progress
 */
async function relayCompanionProgress(jobId, progress) {
	const job = await getJob(jobId)
	if (!job || !ACTIVE_STATES.has(job.state)) return

	const next = await updateJob(jobId, {
		phase: "companion",
		percent: typeof progress.percent === "number" ? Math.min(99, Math.round(progress.percent)) : job.percent,
		bytesReceived: typeof progress.bytes === "number" ? progress.bytes : job.bytesReceived,
		speed: typeof progress.speed === "number" ? progress.speed : job.speed,
		etaSeconds: typeof progress.etaSeconds === "number" ? progress.etaSeconds : job.etaSeconds,
	})
	if (next) await reportProgress(next)
}

/* ================================================================== *
 * Cancel and list
 * ================================================================== */

/** @param {string} jobId */
export async function cancelJob(jobId) {
	const job = await getJob(jobId)
	if (!job) return { ok: false, code: FailureCode.UNKNOWN, message: "No such job" }
	if (!ACTIVE_STATES.has(job.state)) return { ok: true, alreadyFinished: true }

	if (job.strategy === Strategy.COMPANION) {
		// After a worker restart the controller is gone; the port map may still
		// have the port, so try both.
		controllers.get(jobId)?.abort()
		cancelCompanionDownload(jobId)
	} else if (job.strategy === Strategy.CAPTURE) {
		// Must not go through sendToOffscreen: that would try to spin up the
		// *engine* document and evict the recorder mid-session.
		await requestCaptureStop(jobId).catch(() => {})
	} else {
		await sendToOffscreen({ type: MSG.ENGINE_CANCEL, jobId }).catch(() => {})
	}

	await finishFailed(job, { code: FailureCode.CANCELLED, message: "Cancelled" })
	return { ok: true }
}

/** Active and recently finished jobs, newest first. */
export async function listJobs() {
	const jobs = await loadJobs()
	const all = Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt)

	// Garbage-collect anything finished more than ten minutes ago so the session
	// store does not grow without bound.
	const cutoff = Date.now() - 10 * 60 * 1000
	let pruned = false
	for (const job of all) {
		if (!ACTIVE_STATES.has(job.state) && job.startedAt < cutoff) {
			delete jobs[job.jobId]
			pruned = true
		}
	}
	if (pruned) await persist()

	return all.filter((job) => jobs[job.jobId]).map(publicView)
}

/** Drop every job belonging to a tab, e.g. when it navigates away. */
export async function forgetTab(tabId) {
	const jobs = await loadJobs()
	let changed = false
	for (const job of Object.values(jobs)) {
		if (job.tabId !== tabId) continue
		if (ACTIVE_STATES.has(job.state)) continue // let running jobs finish
		delete jobs[job.jobId]
		changed = true
	}
	if (changed) await persist()
}
