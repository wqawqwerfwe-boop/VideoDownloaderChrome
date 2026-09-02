/**
 * Strategy B transport: the native FFmpeg companion host.
 *
 * Strategy A runs inside the browser's security model, which is what makes it
 * fail on some streams: a cross-origin segment read can be refused outright, a
 * multi-gigabyte assembly can exhaust memory, and an exotic codec has no
 * in-browser remuxer. None of those constraints apply to a local ffmpeg
 * process - provided it is handed the same credentials the browser had.
 *
 * This module owns that handoff. It does not decide when to use it; the engine
 * does.
 *
 * @module background/companion
 */

import { FailureCode, EngineError } from "../shared/messages.js"
import { createLogger } from "../shared/logger.js"

const log = createLogger("companion")

/** Must match the `name` field in companion_app/com.unrestricted.video.downloader.json */
export const HOST_NAME = "com.unrestricted.video.downloader"

/** Protocol version this build speaks. The host rejects anything it cannot parse. */
export const PROTOCOL_VERSION = 1

export const CompanionState = Object.freeze({
	/** Not probed yet. */
	UNKNOWN: "unknown",
	/** No host manifest registered, or the registry key is absent. */
	MISSING: "missing",
	/** Host answered, but reported that it cannot find an ffmpeg binary. */
	NO_FFMPEG: "no_ffmpeg",
	/** Host answered and is usable. */
	READY: "ready",
})

/** A missing host is the common case; re-probing on every popup render is wasteful. */
const PROBE_TTL_MS = 30_000

/** @type {{ at: number, result: CompanionProbe }|null} */
let probeCache = null

/**
 * @typedef {Object} CompanionProbe
 * @property {string} state one of CompanionState
 * @property {string|null} version host version string
 * @property {boolean} ffmpeg whether the host found an ffmpeg binary
 * @property {string|null} ffmpegVersion
 * @property {string|null} downloadsDir
 * @property {string|null} detail human-readable reason when unusable
 */

/* ================================================================== *
 * Capability probe
 * ================================================================== */

/**
 * Ask the host whether it is installed and functional.
 *
 * Uses `sendNativeMessage`: a single request with a single reply is precisely
 * this operation's shape, and it avoids leaving a port open.
 *
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<CompanionProbe>}
 */
export async function probeCompanion({ force = false } = {}) {
	if (!force && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
		return probeCache.result
	}

	const result = await runProbe()
	probeCache = { at: Date.now(), result }
	return result
}

/** Drop the cached probe, e.g. after the user has just run the installer. */
export function invalidateCompanionProbe() {
	probeCache = null
}

/** @returns {Promise<CompanionProbe>} */
async function runProbe() {
	if (!chrome.runtime.sendNativeMessage) {
		return {
			state: CompanionState.MISSING,
			version: null,
			ffmpeg: false,
			ffmpegVersion: null,
			downloadsDir: null,
			detail: "This browser build has no native messaging support",
		}
	}

	try {
		const reply = await chrome.runtime.sendNativeMessage(HOST_NAME, {
			action: "ping",
			protocol: PROTOCOL_VERSION,
		})

		if (!reply || reply.ok !== true) {
			return {
				state: CompanionState.MISSING,
				version: null,
				ffmpeg: false,
				ffmpegVersion: null,
				downloadsDir: null,
				detail: reply?.message || "The companion host replied with an unexpected message",
			}
		}

		const hasFfmpeg = Boolean(reply.ffmpeg?.available)
		log.info(`companion ${reply.version || "?"} present; ffmpeg ${hasFfmpeg ? "found" : "missing"}`)

		return {
			state: hasFfmpeg ? CompanionState.READY : CompanionState.NO_FFMPEG,
			version: reply.version ?? null,
			ffmpeg: hasFfmpeg,
			ffmpegVersion: reply.ffmpeg?.version ?? null,
			downloadsDir: reply.downloadsDir ?? null,
			detail: hasFfmpeg ? null : "The companion host is installed but cannot find ffmpeg on PATH",
		}
	} catch (error) {
		// "Specified native messaging host not found." is the expected message when
		// the manifest was never registered - by far the most likely case.
		log.debug("companion probe failed", error)
		return {
			state: CompanionState.MISSING,
			version: null,
			ffmpeg: false,
			ffmpegVersion: null,
			downloadsDir: null,
			detail: error?.message || "The companion host is not installed",
		}
	}
}

/* ================================================================== *
 * Payload assembly
 * ================================================================== */

/**
 * Header values are joined with CRLF and passed to ffmpeg as one `-headers`
 * argument. A newline inside a value would let a crafted cookie or referrer
 * inject arbitrary extra headers, so strip control characters.
 * @param {string} value
 */
function sanitiseHeaderValue(value) {
	return String(value).replace(/[\r\n\u0000]+/g, " ").trim()
}

/**
 * Read the cookies the browser would send for this URL and format them as a
 * single `Cookie` header.
 *
 * This is the difference between ffmpeg succeeding and getting a 403: the
 * segment URLs are usually session-gated, and a bare request from another
 * process carries none of that state.
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function readCookieHeader(url) {
	if (!chrome.cookies?.getAll) return null

	try {
		const cookies = await chrome.cookies.getAll({ url })
		if (!cookies.length) return null

		// Deterministic order keeps the payload stable across calls, which makes
		// the host's logs comparable between runs.
		const pairs = cookies
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((cookie) => `${cookie.name}=${cookie.value}`)

		return sanitiseHeaderValue(pairs.join("; ")) || null
	} catch (error) {
		log.debug("could not read cookies", error)
		return null
	}
}

/** @param {string} url */
function originOf(url) {
	try {
		return new URL(url).origin
	} catch {
		return null
	}
}

/**
 * Build the payload handed to the host.
 *
 * Deliberately sends the *master* manifest URL rather than the resolved variant
 * playlist: if Strategy A failed because our parse was wrong, re-sending our
 * parse would fail the same way. ffmpeg does its own ladder selection, and the
 * requested height is passed as a hint instead of a decision.
 *
 * @param {{
 *   jobId: string,
 *   entry: { url: string, kind?: string, pageUrl?: string, title?: string, drm?: { protected: boolean, scheme: string|null } },
 *   variant?: { height?: number, width?: number, bandwidth?: number, codecs?: string }|null,
 *   filename: string,
 *   duration?: number
 * }} args
 */
export async function buildCompanionPayload({ jobId, entry, variant, filename, duration }) {
	// Strategy B must not become a way around the DRM refusal that Strategy A
	// enforces. The host checks this independently as well.
	if (entry.drm?.protected) {
		throw new EngineError(FailureCode.DRM_PROTECTED, `Stream is ${entry.drm.scheme}-protected`, { retryable: false })
	}

	const pageUrl = entry.pageUrl || null
	const referer = pageUrl ? sanitiseHeaderValue(pageUrl) : null
	const origin = pageUrl ? originOf(pageUrl) : null
	const cookie = await readCookieHeader(entry.url)

	/** @type {Record<string, string>} */
	const headers = {
		// Match the browser that was actually authorised. ffmpeg's default UA is
		// rejected outright by a number of CDNs.
		"User-Agent": sanitiseHeaderValue(navigator.userAgent),
	}
	if (referer) headers.Referer = referer
	if (origin) headers.Origin = sanitiseHeaderValue(origin)
	if (cookie) headers.Cookie = cookie

	return {
		action: "download",
		protocol: PROTOCOL_VERSION,
		jobId,
		manifestUrl: entry.url,
		kind: entry.kind ?? null,
		filename,
		headers,
		duration: duration ?? null,
		quality: variant
			? {
					height: variant.height ?? null,
					width: variant.width ?? null,
					bandwidth: variant.bandwidth ?? null,
					codecs: variant.codecs ?? null,
				}
			: null,
	}
}

/* ================================================================== *
 * Execution
 * ================================================================== */

/** @type {Map<string, chrome.runtime.Port>} */
const activePorts = new Map()

/**
 * Run a download through the companion host.
 *
 * Prefers `connectNative` so ffmpeg's progress can be relayed while it runs.
 * If the port disconnects without having produced anything - a minimal host
 * build that only implements one-shot messaging - the same payload is retried
 * over `sendNativeMessage` rather than surfacing a failure.
 *
 * @param {{
 *   payload: Object,
 *   onProgress?: (progress: Object) => void,
 *   signal?: AbortSignal
 * }} args
 * @returns {Promise<{ path: string, size: number|null, warnings: Array<string> }>}
 */
export async function runCompanionDownload({ payload, onProgress, signal }) {
	try {
		return await runOverPort({ payload, onProgress, signal })
	} catch (error) {
		if (error instanceof EngineError && error.code === FailureCode.CANCELLED) throw error

		// Only fall back when the port produced nothing at all; a host that
		// reported a real error should not have that error replaced.
		if (error?.portProducedOutput) throw error

		log.debug("port transport unavailable; retrying one-shot", error)
		return await runOneShot({ payload, signal, portError: error })
	}
}

/**
 * @param {{ payload: Object, onProgress?: Function, signal?: AbortSignal }} args
 */
function runOverPort({ payload, onProgress, signal }) {
	return new Promise((resolve, reject) => {
		if (!chrome.runtime.connectNative) {
			reject(new Error("connectNative unavailable"))
			return
		}

		let port
		try {
			port = chrome.runtime.connectNative(HOST_NAME)
		} catch (error) {
			reject(error)
			return
		}

		const { jobId } = payload
		activePorts.set(jobId, port)

		let produced = false
		let settled = false
		/** @type {Array<string>} */
		const warnings = []

		const cleanup = () => {
			activePorts.delete(jobId)
			signal?.removeEventListener("abort", onAbort)
			try {
				port.disconnect()
			} catch {
				/* already gone */
			}
		}

		const finish = (fn, value) => {
			if (settled) return
			settled = true
			cleanup()
			fn(value)
		}

		const onAbort = () => {
			try {
				port.postMessage({ action: "cancel", protocol: PROTOCOL_VERSION, jobId })
			} catch {
				/* the host may already be gone */
			}
			finish(reject, new EngineError(FailureCode.CANCELLED, "Cancelled"))
		}

		if (signal?.aborted) {
			finish(reject, new EngineError(FailureCode.CANCELLED, "Cancelled"))
			return
		}
		signal?.addEventListener("abort", onAbort, { once: true })

		port.onMessage.addListener((message) => {
			produced = true

			switch (message?.type) {
				case "progress":
					onProgress?.(message)
					break

				case "warning":
					if (message.message) warnings.push(String(message.message))
					break

				case "done":
					finish(resolve, {
						path: message.path ?? "",
						size: typeof message.size === "number" ? message.size : null,
						warnings,
					})
					break

				case "error": {
					const failure = new EngineError(
						message.code === FailureCode.DRM_PROTECTED ? FailureCode.DRM_PROTECTED : FailureCode.COMPANION_FAILED,
						message.message || "The companion host reported a failure",
						{ retryable: false }
					)
					// Mark it so the one-shot fallback does not mask a real diagnosis.
					failure.portProducedOutput = true
					finish(reject, failure)
					break
				}

				default:
					log.debug("unrecognised host message", message)
			}
		})

		port.onDisconnect.addListener(() => {
			const reason = chrome.runtime.lastError?.message
			if (settled) return

			const error = new Error(reason || "The companion host disconnected")
			// If the host had already streamed messages, this is a crash mid-job and
			// retrying one-shot would just repeat it.
			if (produced) {
				const failure = new EngineError(
					FailureCode.COMPANION_FAILED,
					reason || "The companion host exited before finishing",
					{ retryable: false }
				)
				failure.portProducedOutput = true
				finish(reject, failure)
			} else {
				finish(reject, error)
			}
		})

		port.postMessage(payload)
	})
}

/**
 * One-shot transport, exactly as specified in the brief. The host performs the
 * whole download and replies once.
 *
 * @param {{ payload: Object, signal?: AbortSignal, portError?: unknown }} args
 */
async function runOneShot({ payload, signal, portError }) {
	if (signal?.aborted) throw new EngineError(FailureCode.CANCELLED, "Cancelled")

	if (!chrome.runtime.sendNativeMessage) {
		throw new EngineError(FailureCode.COMPANION_MISSING, "Native messaging is unavailable in this browser")
	}

	let reply
	try {
		reply = await chrome.runtime.sendNativeMessage(HOST_NAME, payload)
	} catch (error) {
		const detail = error?.message || portError?.message || "not installed"
		throw new EngineError(FailureCode.COMPANION_MISSING, `Companion host unavailable (${detail})`, {
			cause: error,
			retryable: false,
		})
	}

	if (reply?.type === "done" || reply?.ok === true) {
		return {
			path: reply.path ?? "",
			size: typeof reply.size === "number" ? reply.size : null,
			warnings: Array.isArray(reply.warnings) ? reply.warnings.map(String) : [],
		}
	}

	throw new EngineError(
		reply?.code === FailureCode.DRM_PROTECTED ? FailureCode.DRM_PROTECTED : FailureCode.COMPANION_FAILED,
		reply?.message || "The companion host did not complete the download",
		{ retryable: false }
	)
}

/**
 * Ask the host to stop a running job.
 * @param {string} jobId
 */
export function cancelCompanionDownload(jobId) {
	const port = activePorts.get(jobId)
	if (!port) return false
	try {
		port.postMessage({ action: "cancel", protocol: PROTOCOL_VERSION, jobId })
	} catch {
		/* the host may already have exited */
	}
	return true
}

/**
 * Human-readable one-liner for the popup.
 * @param {CompanionProbe} probe
 */
export function describeCompanion(probe) {
	switch (probe.state) {
		case CompanionState.READY:
			return `Companion ready${probe.ffmpegVersion ? ` (ffmpeg ${probe.ffmpegVersion})` : ""}`
		case CompanionState.NO_FFMPEG:
			return "Companion installed, but ffmpeg was not found"
		case CompanionState.MISSING:
			return "Companion host not installed"
		default:
			return "Companion status unknown"
	}
}
