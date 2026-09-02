/**
 * ISOLATED-world content script.
 *
 * Two jobs:
 *   1. Watch the DOM for <video>/<audio>/<source> elements the network layer
 *      might have missed (cached media, srcObject, late hydration).
 *   2. Relay messages from the MAIN-world MSE hook to the service worker, since
 *      that hook has no access to chrome.*.
 *
 * Reports are batched: a page that swaps sources rapidly would otherwise wake
 * the service worker on every mutation.
 */

;(() => {
	"use strict"

	const CHANNEL = "ovd:mse"
	const FLUSH_MS = 400

	if (window.__ovdDomObserverInstalled) return
	window.__ovdDomObserverInstalled = true

	/** @type {Map<string, Object>} */
	const pending = new Map()
	const reported = new Set()
	let flushTimer = null

	function absolute(url) {
		try {
			return new URL(url, location.href).href
		} catch {
			return ""
		}
	}

	function queue(item) {
		if (!item.url) return
		// blob:/data: URLs cannot be re-fetched from the background context.
		if (/^(blob:|data:|mediasource:)/i.test(item.url)) return
		if (reported.has(item.url)) return
		pending.set(item.url, item)
		if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
	}

	function flush() {
		flushTimer = null
		if (pending.size === 0) return
		const items = [...pending.values()]
		pending.clear()
		for (const item of items) reported.add(item.url)
		try {
			chrome.runtime.sendMessage({ type: "media:observed", items }, () => void chrome.runtime.lastError)
		} catch {
			// Extension context invalidated (reloaded/updated) - stop cleanly.
			observer?.disconnect()
		}
	}

	/** @param {HTMLMediaElement} el */
	function inspectMediaElement(el) {
		const title = document.title || ""
		const