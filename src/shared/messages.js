/**
 * Message contract between content scripts, the service worker, the popup and
 * (later) the offscreen document.
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
})

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
