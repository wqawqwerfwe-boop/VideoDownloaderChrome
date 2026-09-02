/**
 * Service worker entry point.
 *
 * Deliberately thin. An MV3 worker is evicted after ~30s idle, so it must never
 * own long-running work; it routes messages, keeps the registry and badge in
 * sync, and hands anything durable to code that outlives it. The segmented
 * download orchestrator therefore lives in an offscreen document, wired up in
 * the next commit.
 *
 * @module background/service-worker
 */

import { MSG, FailureCode, broadcast } from "../shared/messages.js"
import { MediaKind, safeFilename } from "../shared/media-types.js"
import * as registry from "./media-registry.js"
import * as sniffer from "./sniffer.js"
import * as badge from "./badge.js"
import * as netRules from "./net-rules.js"
import { probeEntry } from "./probe.js"
import { createLogger, setLogLevel } from "../shared/logger.js"

setLogLevel("info")
const log = createLogger("sw")

/* ------------------------------------------------------------------ *
 * Detection wiring
 * ------------------------------------------------------------------ */

sniffer.setChangeHandler(async (tabId) => {
	await badge.refresh(tabId)
	await broadcast({ type: MSG.MEDIA_UPDATED, tabId })
	void autoProbe(tabId)
})

sniffer.install()

/**
 * Parse newly seen manifests in the background so the ladder is ready by the
 * time the popup opens. Serialised to avoid stampeding a CDN on a page that
 * advertises a dozen renditions at once.
 * @param {number} tabId
 */
let probeChain = Promise.resolve()
function autoProbe(tabId) {
	probeChain = probeChain.then(async () => {
		try {
			const entries = await registry.list(tabId)
			for (const entry of entries) {
				const adaptive = entry.kind === MediaKind.HLS || entry.kind === MediaKind.DASH
				if (!adaptive || entry.probeState !== "idle") continue
				await probeEntry(tabId, entry.id)
				await broadcast({ type: MSG.MEDIA_UPDATED, tabId })
			}
		} catch (err) {
			log.warn("auto-probe failed", err)
		}
	})
	return probeChain
}

/* ------------------------------------------------------------------ *
 * Tab lifecycle
 * ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener(async (tabId) => {
	sniffer.forgetTab(tabId)
	await registry.clear(tabId)
})

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
	// A committed top-level navigation invalidates everything we knew.
	if (changeInfo.status === "loading" && changeInfo.url) {
		sniffer.forgetTab(tabId)
		await registry.clear(tabId)
		await badge.clearBadge(tabId)
		await broadcast({ type: MSG.MEDIA_UPDATED, tabId })
	}
})

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
	await badge.refresh(tabId)
})

chrome.runtime.onStartup.addListener(async () => {
	await netRules.resetAll()
	const tabs = await chrome.tabs.query({})
	await registry.prune(tabs.map((t) => t.id).filter((id) => Number.isInteger(id)))
})

chrome.runtime.onInstalled.addListener(async () => {
	await netRules.resetAll()
	log.info("installed")
})

/* ------------------------------------------------------------------ *
 * Downloads
 * ------------------------------------------------------------------ */

/**
 * Progressive download. A single addressable file needs no assembly, so it goes
 * straight to chrome.downloads and inherits native resume and pause.
 *
 * @param {Object} entry
 * @param {string} pageTitle
 */
async function startProgressive(entry, pageTitle) {
	const filename = safeFilename(pageTitle || entry.title, "", entry.container || "mp4")
	try {
		const downloadId = await chrome.downloads.download({
			url: entry.url,
			filename,
			saveAs: false,
		})
		log.info(`download #${downloadId} -> ${filename}`)
		return { ok: true, downloadId, filename }
	} catch (err) {
		log.error("download failed", err)
		return { ok: false, code: FailureCode.UNKNOWN, message: err?.message || "Download failed" }
	}
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	// Returning true keeps the channel open for the async reply.
	handleMessage(message, sender)
		.then(sendResponse)
		.catch((err) => {
			log.error("handler threw", err)
			sendResponse({ ok: false, code: FailureCode.UNKNOWN, message: err?.message || String(err) })
		})
	return true
})

/**
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 */
async function handleMessage(message, sender) {
	const type = message?.type
	const senderTabId = sender?.tab?.id

	switch (type) {
		case MSG.MEDIA_OBSERVED: {
			if (!Number.isInteger(senderTabId)) return { ok: false }
			let changedAny = false
			for (const candidate of message.items ?? []) {
				const { changed } = await registry.upsert(senderTabId, {
					url: candidate.url,
					kind: candidate.kind,
					container: candidate.container,
					mimeType: candidate.mimeType,
					title: candidate.title,
					duration: candidate.duration,
					width: candidate.width,
					height: candidate.height,
					poster: candidate.poster,
					source: candidate.source || "dom",
					pageUrl: sender?.tab?.url,
					pageTitle: sender?.tab?.title,
				})
				changedAny ||= changed
			}
			if (changedAny) {
				await badge.refresh(senderTabId)
				await broadcast({ type: MSG.MEDIA_UPDATED, tabId: senderTabId })
				void autoProbe(senderTabId)
			}
			return { ok: true }
		}

		case MSG.MEDIA_LIST: {
			const tabId = message.tabId
			const items = await registry.list(tabId)
			const witness = sniffer.segmentActivity(tabId)
			void autoProbe(tabId)
			return { ok: true, items, witness }
		}

		case MSG.MEDIA_CLEAR: {
			sniffer.forgetTab(message.tabId)
			await registry.clear(message.tabId)
			await badge.clearBadge(message.tabId)
			await broadcast({ type: MSG.MEDIA_UPDATED, tabId: message.tabId })
			return { ok: true }
		}

		case MSG.MEDIA_REPROBE: {
			await registry.patch(message.tabId, message.entryId, { probeState: "idle" })
			const entry = await probeEntry(message.tabId, message.entryId)
			await broadcast({ type: MSG.MEDIA_UPDATED, tabId: message.tabId })
			return { ok: true, entry }
		}

		case MSG.JOB_START: {
			const { tabId, entryId, variantIndex } = message
			const entry = await registry.get(tabId, entryId)
			if (!entry) return { ok: false, code: FailureCode.UNKNOWN, message: "Entry no longer available" }

			if (entry.drm?.protected) {
				return {
					ok: false,
					code: FailureCode.DRM_PROTECTED,
					message: `This stream is ${entry.drm.scheme}-protected and is not supported.`,
				}
			}

			if (entry.kind === MediaKind.PROGRESSIVE) {
				const tab = await chrome.tabs.get(tabId).catch(() => null)
				return await startProgressive(entry, tab?.title || entry.pageTitle || "")
			}

			// Segmented streams need the offscreen orchestrator, which is not yet
			// installed. Report it plainly rather than failing silently.
			log.info(`segmented job requested (entry=${entryId} variant=${variantIndex}) - engine pending`)
			return {
				ok: false,
				code: FailureCode.ENGINE_UNAVAILABLE,
				message: "Segmented stream engine arrives in the next commit.",
			}
		}

		case MSG.JOB_LIST:
			return { ok: true, jobs: [] }

		case MSG.JOB_CANCEL:
			return { ok: true }

		default:
			return { ok: false, code: FailureCode.UNKNOWN, message: `Unknown message: ${String(type)}` }
	}
}

log.info("service worker ready")
