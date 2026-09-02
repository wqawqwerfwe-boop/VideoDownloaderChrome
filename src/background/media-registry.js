/**
 * Per-tab registry of detected media.
 *
 * An MV3 service worker is terminated after roughly 30 seconds of inactivity,
 * so nothing may live only in module scope. Every mutation is mirrored to
 * `chrome.storage.session`, and the in-memory map is rehydrated on wake.
 *
 * @module background/media-registry
 */

import { MediaKind, isFetchable } from "../shared/media-types.js"
import { createLogger } from "../shared/logger.js"

const log = createLogger("registry")

/** Bound per tab so a long-lived page cannot grow the store without limit. */
const MAX_ENTRIES_PER_TAB = 250
const STORAGE_KEY = "registry:v1"

/** @type {Map<number, Map<string, Object>>} */
let tabs = new Map()
let hydrated = false
let flushTimer = null

async function hydrate() {
	if (hydrated) return
	hydrated = true
	try {
		const stored = await chrome.storage.session.get(STORAGE_KEY)
		const raw = stored?.[STORAGE_KEY]
		if (raw) {
			tabs = new Map(Object.entries(raw).map(([tabId, entries]) => [Number(tabId), new Map(Object.entries(entries))]))
			log.debug(`rehydrated ${tabs.size} tab(s)`)
		}
	} catch (err) {
		log.warn("hydrate failed", err)
	}
}

/** Coalesce writes; the sniffer can fire dozens of times per second. */
function scheduleFlush() {
	if (flushTimer) return
	flushTimer = setTimeout(async () => {
		flushTimer = null
		try {
			const plain = {}
			for (const [tabId, entries] of tabs) plain[tabId] = Object.fromEntries(entries)
			await chrome.storage.session.set({ [STORAGE_KEY]: plain })
		} catch (err) {
			log.warn("flush failed", err)
		}
	}, 250)
}

/**
 * Normalise a URL for deduplication. Cache-busting query params mean the same
 * asset arrives under many spellings, so compare on origin + path + a stable
 * subset of the query.
 * @param {string} url
 */
export function dedupeKey(url) {
	try {
		const u = new URL(url)
		const keep = new URLSearchParams()
		for (const [k, v] of u.searchParams) {
			if (/^(_|cb$|cache|ts$|time|rand|nonce|expires|token|sig|hdnts)/i.test(k)) continue
			keep.append(k, v)
		}
		keep.sort()
		const qs = keep.toString()
		return `${u.origin}${u.pathname}${qs ? `?${qs}` : ""}`
	} catch {
		return url
	}
}

/**
 * Insert or merge an entry.
 * @param {number} tabId
 * @param {Object} entry
 * @returns {Promise<{ changed: boolean, entry: Object|null }>}
 */
export async function upsert(tabId, entry) {
	await hydrate()
	if (!Number.isInteger(tabId) || tabId < 0) return { changed: false, entry: null }
	if (!isFetchable(entry.url)) return { changed: false, entry: null }

	let entries = tabs.get(tabId)
	if (!entries) {
		entries = new Map()
		tabs.set(tabId, entries)
	}

	const id = dedupeKey(entry.url)
	const existing = entries.get(id)

	if (existing) {
		// Later observations carry better metadata (size from headers, title from DOM).
		let changed = false
		for (const [k, v] of Object.entries(entry)) {
			if (v === undefined || v === null || v === "") continue
			if (existing[k] === v) continue
			if (k === "kind" && existing.kind !== MediaKind.UNKNOWN && v === MediaKind.UNKNOWN) continue
			existing[k] = v
			changed = true
		}
		existing.seenAt = Date.now()
		if (changed) scheduleFlush()
		return { changed, entry: existing }
	}

	if (entries.size >= MAX_ENTRIES_PER_TAB) {
		// Evict the oldest, but never an entry that already has a parsed ladder.
		const victim = [...entries.entries()]
			.filter(([, e]) => !e.variants?.length)
			.sort((a, b) => (a[1].seenAt || 0) - (b[1].seenAt || 0))[0]
		if (victim) entries.delete(victim[0])
		else return { changed: false, entry: null }
	}

	const record = {
		id,
		seenAt: Date.now(),
		probeState: "idle",
		variants: [],
		audioTracks: [],
		...entry,
	}
	entries.set(id, record)
	scheduleFlush()
	return { changed: true, entry: record }
}

/**
 * @param {number} tabId
 * @param {string} id
 * @param {Object} patch
 */
export async function patch(tabId, id, patch_) {
	await hydrate()
	const entry = tabs.get(tabId)?.get(id)
	if (!entry) return null
	Object.assign(entry, patch_)
	scheduleFlush()
	return entry
}

/**
 * Entries a human would want to see: manifests and progressive files, never
 * raw fragments.
 * @param {number} tabId
 */
export async function list(tabId) {
	await hydrate()
	const entries = tabs.get(tabId)
	if (!entries) return []
	return [...entries.values()]
		.filter((e) => e.kind !== MediaKind.SEGMENT && e.kind !== MediaKind.UNKNOWN)
		.sort((a, b) => b.seenAt - a.seenAt)
}

/** @param {number} tabId */
export async function count(tabId) {
	return (await list(tabId)).length
}

/** @param {number} tabId @param {string} id */
export async function get(tabId, id) {
	await hydrate()
	return tabs.get(tabId)?.get(id) ?? null
}

/** @param {number} tabId */
export async function clear(tabId) {
	await hydrate()
	tabs.delete(tabId)
	scheduleFlush()
}

/** Drop state for tabs that no longer exist. */
export async function prune(liveTabIds) {
	await hydrate()
	const live = new Set(liveTabIds)
	let removed = 0
	for (const tabId of [...tabs.keys()]) {
		if (!live.has(tabId)) {
			tabs.delete(tabId)
			removed++
		}
	}
	if (removed) scheduleFlush()
	return removed
}
