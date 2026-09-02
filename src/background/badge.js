/**
 * Per-tab badge showing how many media items were detected.
 * @module background/badge
 */

import { count } from "./media-registry.js"
import { createLogger } from "../shared/logger.js"

const log = createLogger("badge")

const COLOR_IDLE = "#10b981"
const COLOR_BUSY = "#f59e0b"

/**
 * @param {number} tabId
 * @param {{ busy?: boolean }} [options]
 */
export async function refresh(tabId, options = {}) {
	if (!Number.isInteger(tabId) || tabId < 0) return
	try {
		const n = await count(tabId)
		await chrome.action.setBadgeText({ tabId, text: n > 0 ? (n > 99 ? "99+" : String(n)) : "" })
		await chrome.action.setBadgeBackgroundColor({ tabId, color: options.busy ? COLOR_BUSY : COLOR_IDLE })
	} catch (err) {
		// The tab can vanish between the query and the write; that is not an error.
		log.debug("badge update skipped", err?.message)
	}
}

/** @param {number} tabId */
export async function clearBadge(tabId) {
	try {
		await chrome.action.setBadgeText({ tabId, text: "" })
	} catch {
		/* tab gone */
	}
}
