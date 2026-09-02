/**
 * Dynamic declarativeNetRequest header rules.
 *
 * DNR cannot observe traffic (it has no JS callback), so it plays no part in
 * detection. Its job here is narrow and specific: many CDNs reject requests
 * that lack the Referer/Origin the player would have sent. These rules restore
 * those headers, scoped to `tabIds: [-1]` so they apply only to fetches issued
 * by the extension itself and never alter ordinary page traffic.
 *
 * `tabIds` conditions are only valid on session-scoped rules, which is why the
 * static ruleset ships empty.
 *
 * @module background/net-rules
 */

import { createLogger } from "../shared/logger.js"

const log = createLogger("net-rules")

const ID_MIN = 9000
const ID_MAX = 9499
let nextId = ID_MIN

function allocateId() {
	const id = nextId++
	if (nextId > ID_MAX) nextId = ID_MIN
	return id
}

/**
 * Send page-accurate Referer/Origin on extension-issued requests to one host.
 *
 * @param {string} mediaHost host of the media/segment requests
 * @param {string} pageUrl the page the media belongs to
 * @returns {Promise<number|null>} rule id, for later removal
 */
export async function applyRefererRule(mediaHost, pageUrl) {
	if (!mediaHost || !pageUrl) return null
	let origin
	try {
		origin = new URL(pageUrl).origin
	} catch {
		return null
	}
	// urlFilter must be ASCII; punycode any IDN host.
	if (!/^[\x21-\x7e]+$/.test(mediaHost)) return null

	const id = allocateId()
	try {
		await chrome.declarativeNetRequest.updateSessionRules({
			removeRuleIds: [id],
			addRules: [
				{
					id,
					priority: 1,
					action: {
						type: "modifyHeaders",
						requestHeaders: [
							{ header: "referer", operation: "set", value: pageUrl },
							{ header: "origin", operation: "set", value: origin },
						],
					},
					condition: {
						urlFilter: `||${mediaHost}^`,
						resourceTypes: ["xmlhttprequest", "media", "other"],
						tabIds: [-1],
					},
				},
			],
		})
		log.debug(`referer rule ${id} -> ${mediaHost}`)
		return id
	} catch (err) {
		log.warn("could not install referer rule", err)
		return null
	}
}

/** @param {Array<number>} ids */
export async function removeRules(ids) {
	const removeRuleIds = ids.filter((n) => Number.isInteger(n))
	if (!removeRuleIds.length) return
	try {
		await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds })
	} catch (err) {
		log.debug("rule cleanup failed", err?.message)
	}
}

/** Wipe every rule this module owns. Called on startup. */
export async function resetAll() {
	try {
		const existing = await chrome.declarativeNetRequest.getSessionRules()
		const mine = existing.filter((r) => r.id >= ID_MIN && r.id <= ID_MAX).map((r) => r.id)
		if (mine.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: mine })
	} catch (err) {
		log.debug("reset failed", err?.message)
	}
}
