/**
 * Network sniffer.
 *
 * Built on *observational* chrome.webRequest, which remains fully available in
 * Manifest V3 (only the blocking variant was restricted to force-installed
 * policy extensions). declarativeNetRequest is not usable for detection: it is
 * declarative by design and never calls back into JavaScript.
 *
 * Two listeners cooperate:
 *   onBeforeRequest    catches URL-shaped matches early, even if the response
 *                      never arrives or carries useless headers.
 *   onHeadersReceived  supplies the authoritative Content-Type plus
 *                      Content-Length for size estimation.
 *
 * @module background/sniffer
 */

import { classify, MediaKind, looksLikeSegment, isFetchable } from "../shared/media-types.js"
import { upsert } from "./media-registry.js"
import { createLogger } from "../shared/logger.js"

const log = createLogger("sniffer")

const FILTER = {
	urls: ["<all_urls>"],
	types: /** @type {chrome.webRequest.ResourceType[]} */ ([
		"media",
		"xmlhttprequest",
		"object",
		"other",
		"main_frame",
		"sub_frame",
	]),
}

/**
 * Segment traffic is enormous and individually worthless, but it is proof that
 * an adaptive stream is playing. Track only a rolling fingerprint per tab so we
 * can tell the user "a stream is here" even when the manifest was fetched before
 * the extension woke up.
 * @type {Map<number, { count: number, lastUrl: string, at: number }>}
 */
const segmentWitness = new Map()

/** @param {chrome.webRequest.HttpHeader[]|undefined} headers @param {string} name */
function header(headers, name) {
	if (!headers) return ""
	const lower = name.toLowerCase()
	for (const h of headers) if (h.name.toLowerCase() === lower) return h.value ?? ""
	return ""
}

let onChange = async () => {}

/** @param {(tabId: number) => Promise<void>} handler */
export function setChangeHandler(handler) {
	onChange = handler
}

/**
 * @param {number} tabId
 * @param {string} url
 * @param {string} mimeType
 * @param {number} size
 */
async function record(tabId, url, mimeType, size) {
	const { kind, container, mimeType: mime } = classify({ url, mimeType })

	if (kind === MediaKind.SEGMENT || (kind === MediaKind.UNKNOWN && looksLikeSegment(url))) {
		const w = segmentWitness.get(tabId) ?? { count: 0, lastUrl: "", at: 0 }
		w.count++
		w.lastUrl = url
		w.at = Date.now()
		segmentWitness.set(tabId, w)
		return
	}

	if (kind === MediaKind.UNKNOWN) return

	// Sub-1MB "videos" are almost always ad bumpers, sprites or tracking pixels.
	if (kind === MediaKind.PROGRESSIVE && size > 0 && size < 64 * 1024) return

	const { changed } = await upsert(tabId, {
		url,
		kind,
		container,
		mimeType: mime,
		size: size || 0,
		source: "network",
	})

	if (changed) {
		log.debug(`+ ${kind} ${url.slice(0, 110)}`)
		await onChange(tabId)
	}
}

function onBeforeRequest(details) {
	const { tabId, url } = details
	// tabId -1 means the request came from the extension itself or the browser.
	if (tabId < 0 || !isFetchable(url)) return
	const { kind } = classify({ url })
	if (kind === MediaKind.HLS || kind === MediaKind.DASH || kind === MediaKind.PROGRESSIVE) {
		record(tabId, url, "", 0).catch((err) => log.warn("record failed", err))
	} else if (kind === MediaKind.SEGMENT || looksLikeSegment(url)) {
		record(tabId, url, "", 0).catch(() => {})
	}
}

function onHeadersReceived(details) {
	const { tabId, url, responseHeaders, statusCode } = details
	if (tabId < 0 || !isFetchable(url)) return
	if (statusCode >= 400) return

	const contentType = header(responseHeaders, "content-type")
	const length = Number(header(responseHeaders, "content-length")) || 0

	// A 206 reports only the slice length; recover the true size from Content-Range.
	let size = length
	if (statusCode === 206) {
		const range = header(responseHeaders, "content-range")
		const m = /\/(\d+)\s*$/.exec(range)
		if (m) size = Number(m[1]) || length
	}

	record(tabId, url, contentType, size).catch((err) => log.warn("record failed", err))
}

/** @param {number} tabId */
export function segmentActivity(tabId) {
	return segmentWitness.get(tabId) ?? null
}

/** @param {number} tabId */
export function forgetTab(tabId) {
	segmentWitness.delete(tabId)
}

/** Attach listeners. Safe to call on every service worker wake. */
export function install() {
	if (!chrome.webRequest?.onBeforeRequest.hasListener(onBeforeRequest)) {
		chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, FILTER)
	}
	if (!chrome.webRequest?.onHeadersReceived.hasListener(onHeadersReceived)) {
		chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived, FILTER, ["responseHeaders"])
	}
	log.info("listeners installed")
}
