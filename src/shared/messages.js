/**
 * Message contract between content scripts, the service worker, the popup and
 * the offscreen document.
 * @module shared/messages
 */

export const MSG = Object.freeze({
	/** content script -> SW: a media candidate was observed in the page */
	MEDIA_OBSERVED: "media:observed",
	/** SW -> popup: broadcast that a tab's registry changed */
	MEDIA_UPDATED: "media:updated",
	/** popup -> SW: request the current entries for a tab */
	MEDIA_LIST: "media:list",
	/** popup -> SW: drop everything known about a tab */
	MEDIA_CLEAR: "media:clear",
	/** popup -> SW: re-fetch and re-parse a manifest */
	MEDIA_REPROBE: "media:reprobe",

	/** popup -> SW: begin a download job */
	JOB_START: "job:start",
	/** popup -> SW: abort a running job */
	JOB_CANCEL: "job:cancel",
	/** popup -> SW: list active jobs */
	JOB_LIST: "job:list",
	/** SW -> popup: job lifecycle updates */
	JOB_PROGRESS: "job:progress",
	JOB_DONE: "job:done",
	JOB_ERROR: "job:error",

	/** SW -> offscreen: run a segmented download */
	ENGINE_RUN: "engine:run",
	/** SW -> offscreen: abort a running download */
	ENGINE_CANCEL: "engine:cancel",
	/** offscreen -> SW: incremental progress for a job */
	ENGINE_PROGRESS: "engine:progress",
	/** offscreen -> SW: terminal result for a job */
	ENGINE_RESULT: "engine:result",
	/** SW -> offscreen: the saved file has been read, drop the blob and temp file */
	ENGINE_RELEASE: "engine:release",
	/** SW -> offscreen: liveness check used when reusing an existing document */
	ENGINE_PING: "engine:ping",

	/** SW -> offscreen recorder: begin a capture session (strategy C) */
	CAPTURE_RUN: "capture:run",
	/** offscreen recorder -> SW: make the source tab play and watch for its end */
	CAPTURE_PREPARE_TAB: "capture:prepare-tab",
	/** content script -> SW: the tab's own player reached the end of the stream */
	CAPTURE_TAB_ENDED: "capture:tab-ended",

	/** popup -> SW: is the native companion installed? */
	COMPANION_PROBE: "companion:probe",
	/** SW -> popup: companion availability and version */
	COMPANION_STATUS: "companion:status",
})

/**
 * Wire states for the Sample-AES capture handoff. These mirror the companion
 * host (companion_app/host.py) exactly: when a manifest is Sample-AES
 * protected - HLS transport encryption with the key published in the playlist,
 * as opposed to licence-server DRM - the host refuses to download it and
 * instead reports `requires_capture`, and the job continues in the offscreen
 * recorder instead of terminating.
 */
export const CaptureHandoff = Object.freeze({
	/** Host packet type/status: the specialised capture handoff state. */
	STATUS: "requires_capture",
	/** Host packet code for a Sample-AES manifest. */
	CODE_SAMPLE_AES: "sample_aes_detected",
})

/**
 * Every extension context receives every `chrome.runtime.sendMessage`, so
 * messages carry an explicit destination. Without this the offscreen document
 * would answer popup->SW traffic and win the race for the reply.
 */
export const Target = Object.freeze({
	SERVICE_WORKER: "sw",
	OFFSCREEN: "offscreen",
})

/**
 * Reason codes surfaced to the UI. Every failure path maps to one of these so
 * the popup never has to show a raw exception string.
 */
export const FailureCode = Object.freeze({
	NETWORK_TIMEOUT: "network_timeout",
	SEGMENT_FAILED: "segment_failed",
	MANIFEST_UNPARSEABLE: "manifest_unparseable",
	DRM_PROTECTED: "drm_protected",
	ENGINE_UNAVAILABLE: "engine_unavailable",
	COMPANION_MISSING: "companion_missing",
	QUOTA_EXCEEDED: "quota_exceeded",
	CANCELLED: "cancelled",
	UNKNOWN: "unknown",

	/** A codec the vendored remuxer cannot describe. Escalates to Strategy B. */
	UNSUPPORTED_CODEC: "unsupported_codec",
	/** The segment origin refused a cross-origin read. Escalates to Strategy B. */
	CORS_BLOCKED: "cors_blocked",
	/** Output too large to assemble in the browser. Escalates to Strategy B. */
	MEMORY_LIMIT: "memory_limit",
	/** The companion host is installed but the job failed inside it. */
	COMPANION_FAILED: "companion_failed",
	/** A playlist with no ENDLIST tag; only the published window can be captured. */
	LIVE_STREAM: "live_stream",
	/**
	 * Not a failure: the companion host inspected the manifest, found
	 * Sample-AES, and handed the job to the offscreen recorder (strategy C).
	 * Carried on an EngineError purely so it can travel the existing
	 * `runCompanionDownload` rejection path without a second error type.
	 */
	REQUIRES_CAPTURE: "requires_capture",
})

/**
 * An error that already carries a UI-presentable reason code.
 *
 * The engine throws these so the cascade can decide, from the code alone,
 * whether a failure is worth retrying with the native companion host or is
 * terminal (a cancellation or a DRM refusal).
 */
export class EngineError extends Error {
	/**
	 * @param {string} code one of FailureCode
	 * @param {string} message
	 * @param {{ cause?: unknown, retryable?: boolean, scheme?: string }} [options]
	 */
	constructor(code, message, options = {}) {
		super(message)
		this.name = "EngineError"
		this.code = code
		this.cause = options.cause
		/**
		 * DRM scheme named by a DRM_PROTECTED refusal, so the cascade can tell
		 * "widevine" (terminal) from "sample-aes" (capture-eligible) without
		 * pattern-matching the human-readable message.
		 */
		this.scheme = options.scheme ?? null
		/** Whether escalating to Strategy B could plausibly help. */
		this.retryable = options.retryable ?? RETRYABLE_CODES.has(code)
	}
}

/** Failures the native companion host has a real chance of succeeding at. */
const RETRYABLE_CODES = new Set([
	FailureCode.NETWORK_TIMEOUT,
	FailureCode.SEGMENT_FAILED,
	FailureCode.MANIFEST_UNPARSEABLE,
	FailureCode.UNSUPPORTED_CODEC,
	FailureCode.CORS_BLOCKED,
	FailureCode.MEMORY_LIMIT,
	FailureCode.QUOTA_EXCEEDED,
	FailureCode.ENGINE_UNAVAILABLE,
	FailureCode.UNKNOWN,
])

/**
 * `chrome.runtime.sendMessage` rejects when no receiver exists (e.g. the popup
 * is closed). That is an expected, benign condition, so swallow it.
 * @param {unknown} message
 */
export async function broadcast(message) {
	try {
		await chrome.runtime.sendMessage(message)
	} catch {
		/* no listener - fine */
	}
}
