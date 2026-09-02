/**
 * Popup UI.
 *
 * Renders the per-tab media registry: one card per detected item, one row per
 * rendition in its quality ladder, with a download button - or a live progress
 * bar - on each row.
 *
 * Everything shown here (page titles, URLs, codec strings) originates from
 * arbitrary websites, so the DOM is built node by node and all text goes
 * through textContent. There is no innerHTML in this file, deliberately.
 *
 * @module popup/popup
 */

import { MSG, FailureCode } from "../shared/messages.js"
import { MediaKind, Strategy, humanBytes, humanBitrate, humanDuration, qualityLabel } from "../shared/media-types.js"

const listEl = document.getElementById("list")
const countEl = document.getElementById("count")
const statusEl = document.getElementById("status")
const clearBtn = document.getElementById("clear")
const toastEl = document.getElementById("toast")

/** @type {number|null} */
let tabId = null
let toastTimer = null

/**
 * Progress state lives here rather than in the DOM.
 *
 * MEDIA_UPDATED re-renders the whole list, so a progress bar that existed only
 * as DOM would be wiped the moment another manifest was detected mid-download.
 * Keyed by entry + rendition so a re-render can restore it.
 *
 * @type {Map<string, Object>}
 */
const activeJobs = new Map()
/** @type {Map<string, string>} jobId -> activeJobs key */
const jobKeys = new Map()

/** @param {string} entryId @param {number} variantIndex */
function jobKey(entryId, variantIndex) {
	return `${entryId}:${variantIndex}`
}

/* ------------------------------------------------------------------ *
 * Tiny DOM helpers
 * ------------------------------------------------------------------ */

/**
 * @param {string} tag
 * @param {{ class?: string, text?: string, title?: string, attrs?: Record<string, string|undefined> }} [opts]
 * @param {Array<Node|null|undefined>} [kids]
 */
function el(tag, opts = {}, kids = []) {
	const node = document.createElement(tag)
	if (opts.class) node.className = opts.class
	if (opts.text !== undefined) node.textContent = opts.text
	if (opts.title) node.title = opts.title
	if (opts.attrs) {
		for (const [key, value] of Object.entries(opts.attrs)) {
			if (value !== undefined && value !== null) node.setAttribute(key, String(value))
		}
	}
	for (const kid of kids) if (kid) node.append(kid)
	return node
}

function chip(text, variant) {
	return el("span", { class: variant ? `chip chip-${variant}` : "chip", text })
}

function hostOf(url) {
	try {
		return new URL(url).host
	} catch {
		return ""
	}
}

/**
 * The service worker may be asleep or mid-restart; a rejected sendMessage is a
 * normal condition, not a crash.
 * @param {Object} message
 */
async function send(message) {
	try {
		const res = await chrome.runtime.sendMessage(message)
		return res ?? { ok: false, message: "Background worker did not respond" }
	} catch (err) {
		return { ok: false, message: err?.message || "Background worker unavailable" }
	}
}

function toast(text, kind = "info") {
	if (!text) return
	toastEl.textContent = text
	toastEl.className = `toast toast-${kind}`
	toastEl.hidden = false
	if (toastTimer) clearTimeout(toastTimer)
	toastTimer = setTimeout(() => {
		toastEl.hidden = true
	}, 4200)
}

/* ------------------------------------------------------------------ *
 * Progress presentation
 * ------------------------------------------------------------------ */

/** @param {number} bytesPerSecond */
function humanSpeed(bytesPerSecond) {
	if (!bytesPerSecond || bytesPerSecond < 1) return ""
	return `${humanBytes(bytesPerSecond)}/s`
}

/** @param {number|null} seconds */
function humanEta(seconds) {
	if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return ""
	if (seconds < 60) return `${Math.round(seconds)}s left`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m left`
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`
}

/** @param {Object} job */
function describeProgress(job) {
	if (job.phase === "preparing") return "Reading manifest\u2026"
	if (job.phase === "muxing") return "Merging audio and video\u2026"
	if (job.phase === "saving") return "Saving\u2026"

	const parts = [`${job.percent ?? 0}%`]
	if (job.bytesReceived) parts.push(humanBytes(job.bytesReceived))

	const speed = humanSpeed(job.speed)
	if (speed) parts.push(speed)
	else {
		const eta = humanEta(job.etaSeconds)
		if (eta) parts.push(eta)
	}

	return parts.join(" \u00b7 ")
}

/** @param {Object} job */
function renderProgress(job) {
	const fill = el("div", { class: "progress-fill" })
	fill.style.width = `${Math.max(0, Math.min(100, job.percent ?? 0))}%`

	return el("div", { class: "progress", attrs: { "data-progress": job.jobId } }, [
		el("div", { class: "progress-body" }, [
			el("div", { class: "progress-track" }, [fill]),
			el("div", { class: "progress-meta", text: describeProgress(job) }),
		]),
		job.strategy === Strategy.COMPANION ? chip("ffmpeg", "muted") : null,
		el("button", {
			class: "ghost",
			text: "Cancel",
			attrs: { type: "button", "data-cancel": job.jobId },
		}),
	])
}

/**
 * Repaint one job in place. A full re-render would fight with the user
 * scrolling the list four times a second.
 * @param {Object} job
 */
function paintProgress(job) {
	const node = listEl.querySelector(`[data-progress="${CSS.escape(job.jobId)}"]`)
	if (!node) {
		void refresh()
		return
	}
	const fill = node.querySelector(".progress-fill")
	if (fill) fill.style.width = `${Math.max(0, Math.min(100, job.percent ?? 0))}%`
	const meta = node.querySelector(".progress-meta")
	if (meta) meta.textContent = describeProgress(job)
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function kindLabel(entry) {
	if (entry.kind === MediaKind.HLS) return "HLS"
	if (entry.kind === MediaKind.DASH) return "DASH"
	return (entry.container || "file").toUpperCase()
}

function titleOf(entry) {
	return entry.title || entry.pageTitle || hostOf(entry.url) || "Untitled"
}

/**
 * @param {Object} entry
 * @param {Object} variant
 */
function renderVariantRow(entry, variant) {
	const index = Number.isInteger(variant.index) ? variant.index : 0

	let label
	if (variant.height || variant.width) label = qualityLabel(variant.width, variant.height)
	else if (variant.bandwidth) label = humanBitrate(variant.bandwidth)
	else label = "Source"

	const meta = []
	if (variant.width && variant.height) meta.push(`${variant.width}\u00d7${variant.height}`)
	if (variant.bandwidth) meta.push(humanBitrate(variant.bandwidth))
	if (variant.frameRate) meta.push(`${variant.frameRate} fps`)
	if (variant.segmentCount) meta.push(`${variant.segmentCount} segments`)

	const estimated = variant.estimatedBytes || 0
	// Progressive entries carry a real Content-Length; adaptive ladders only ever
	// have an estimate derived from declared bandwidth, so mark it as one.
	const exact = entry.kind === MediaKind.PROGRESSIVE
	const sizeText = estimated ? `${exact ? "" : "~"}${humanBytes(estimated)}` : ""

	const job = activeJobs.get(jobKey(entry.id, index))

	const side = job
		? [renderProgress(job)]
		: [
				sizeText ? el("span", { class: "size", text: sizeText }) : null,
				variant.needsMux ? chip("+audio", "muted") : null,
				el("button", {
					class: "primary",
					text: "Download",
					attrs: { type: "button", "data-entry": entry.id, "data-variant": String(index) },
				}),
			]

	return el("div", { class: job ? "row row-active" : "row" }, [
		el("div", { class: "row-main" }, [
			el("span", { class: "quality", text: label }),
			meta.length ? el("span", { class: "meta", text: meta.join(" \u00b7 ") }) : null,
			variant.codecs ? el("span", { class: "codecs", text: variant.codecs, title: variant.codecs }) : null,
		]),
		el("div", { class: "row-side" }, side),
	])
}

/** @param {Object} entry */
function renderEntry(entry) {
	const head = el("div", { class: "card-head" }, [
		el("div", { class: "title", text: titleOf(entry), title: entry.url }),
		el("div", { class: "sub" }, [
			chip(kindLabel(entry), entry.kind === MediaKind.PROGRESSIVE ? "file" : "stream"),
			entry.isLive ? chip("LIVE", "live") : null,
			el("span", { class: "host", text: hostOf(entry.url) }),
			entry.duration ? el("span", { text: humanDuration(entry.duration) }) : null,
		]),
	])

	const body = el("div", { class: "card-body" })

	// Protected streams are shown, named, and left non-actionable. This project
	// does not circumvent DRM, so offering a button here would be a lie.
	if (entry.drm?.protected || entry.probeState === "unsupported") {
		const scheme = entry.drm?.scheme
		body.append(
			el("div", { class: "notice notice-block" }, [
				el("strong", { text: "Protected stream" }),
				el("span", {
					text: scheme
						? `Encrypted with ${scheme}. Downloading it would mean circumventing DRM, which this extension does not do.`
						: "This stream is DRM-protected and cannot be downloaded.",
				}),
			])
		)
		return el("article", { class: "card card-blocked" }, [head, body])
	}

	if (entry.kind === MediaKind.PROGRESSIVE) {
		body.append(
			renderVariantRow(entry, {
				index: 0,
				width: entry.width,
				height: entry.height,
				estimatedBytes: entry.size,
			})
		)
		return el("article", { class: "card" }, [head, body])
	}

	switch (entry.probeState) {
		case "idle":
		case "probing":
			body.append(
				el("div", { class: "notice" }, [
					el("span", { class: "spinner", attrs: { "aria-hidden": "true" } }),
					el("span", { text: "Reading manifest\u2026" }),
				])
			)
			break

		case "error":
			body.append(
				el("div", { class: "notice notice-warn" }, [
					el("span", { text: entry.probeError || "Could not read the manifest." }),
					el("button", {
						class: "ghost",
						text: "Retry",
						attrs: { type: "button", "data-retry": entry.id },
					}),
				])
			)
			break

		default:
			if (!entry.variants?.length) {
				body.append(el("div", { class: "notice", text: "No playable renditions found." }))
				break
			}
			for (const variant of entry.variants) body.append(renderVariantRow(entry, variant))
			if (entry.audioTracks?.length) {
				const n = entry.audioTracks.length
				body.append(
					el("div", {
						class: "hint",
						text: `${n} separate audio track${n > 1 ? "s" : ""} detected \u00b7 merged into the download`,
					})
				)
			}
	}

	return el("article", { class: "card" }, [head, body])
}

/**
 * @param {Array<Object>} items
 * @param {{ count: number }|null|undefined} witness
 */
function render(items, witness) {
	listEl.replaceChildren()
	countEl.textContent = items.length ? String(items.length) : ""

	if (!items.length) {
		const empty = el("div", { class: "empty" })
		if (witness?.count) {
			// Segments are flowing but no manifest was captured, which means the
			// playlist was fetched before the worker woke up.
			empty.append(
				el("p", { class: "empty-title", text: "A stream is playing" }),
				el("p", {
					text: `${witness.count} segments seen, but the manifest was requested before the extension could read it. Reload the page to capture it.`,
				})
			)
		} else {
			empty.append(
				el("p", { class: "empty-title", text: "No media detected" }),
				el("p", { text: "Play something on this tab and it will show up here." })
			)
		}
		listEl.append(empty)
		return
	}

	for (const entry of items) listEl.append(renderEntry(entry))
}

async function refresh() {
	if (!Number.isInteger(tabId)) return
	const res = await send({ type: MSG.MEDIA_LIST, tabId })
	if (!res.ok) {
		statusEl.textContent = res.message || "Could not read the registry"
		return
	}
	render(res.items || [], res.witness)
}

/**
 * Rebuild progress state from the worker.
 *
 * Without this, reopening the popup during a download would show an idle
 * Download button for a rendition that is already 60% fetched.
 */
async function restoreJobs() {
	const res = await send({ type: MSG.JOB_LIST })
	if (!res.ok) return

	activeJobs.clear()
	jobKeys.clear()
	for (const job of res.jobs ?? []) {
		if (job.tabId !== tabId) continue
		if (["done", "failed", "cancelled"].includes(job.state)) continue
		const key = jobKey(job.entryId, job.variantIndex)
		activeJobs.set(key, job)
		jobKeys.set(job.jobId, key)
	}
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

// Delegated: rows are re-rendered on every update, so per-button listeners
// would leak.
listEl.addEventListener("click", async (event) => {
	const button = event.target instanceof Element ? event.target.closest("button") : null
	if (!button) return

	const retryId = button.dataset.retry
	if (retryId) {
		button.disabled = true
		button.textContent = "Retrying\u2026"
		await send({ type: MSG.MEDIA_REPROBE, tabId, entryId: retryId })
		await refresh()
		return
	}

	const cancelId = button.dataset.cancel
	if (cancelId) {
		button.disabled = true
		button.textContent = "Stopping\u2026"
		await send({ type: MSG.JOB_CANCEL, jobId: cancelId })
		return
	}

	const entryId = button.dataset.entry
	if (!entryId) return

	const variantIndex = Number(button.dataset.variant) || 0
	const original = button.textContent
	button.disabled = true
	button.textContent = "Starting\u2026"

	const res = await send({ type: MSG.JOB_START, tabId, entryId, variantIndex })

	if (res.ok) {
		// Segmented jobs report progress; a progressive file is already saving.
		if (res.segmented && res.jobId) {
			const key = jobKey(entryId, variantIndex)
			activeJobs.set(key, {
				jobId: res.jobId,
				entryId,
				variantIndex,
				state: "preparing",
				phase: "preparing",
				percent: 0,
				strategy: res.strategy,
			})
			jobKeys.set(res.jobId, key)
			await refresh()
			return
		}

		button.textContent = "Saved"
		toast(res.filename ? `Downloading ${res.filename}` : "Download started", "ok")
		return
	}

	button.disabled = false
	button.textContent = original

	if (res.code === FailureCode.DRM_PROTECTED) toast(res.message, "warn")
	else if (res.code === FailureCode.COMPANION_MISSING) toast(res.message, "warn")
	else toast(res.message || "Download failed", "error")
})

clearBtn.addEventListener("click", async () => {
	await send({ type: MSG.MEDIA_CLEAR, tabId })
	await refresh()
})

chrome.runtime.onMessage.addListener((message) => {
	if (message?.type === MSG.MEDIA_UPDATED && message.tabId === tabId) {
		void refresh()
		return
	}

	const job = message?.job
	if (!job || job.tabId !== tabId) return

	switch (message.type) {
		case MSG.JOB_PROGRESS: {
			const key = jobKey(job.entryId, job.variantIndex)
			const known = activeJobs.has(key)
			activeJobs.set(key, job)
			jobKeys.set(job.jobId, key)
			// A job started from another popup window has no row yet.
			if (known) paintProgress(job)
			else void refresh()
			break
		}

		case MSG.JOB_DONE: {
			clearJob(job)
			const where = job.path ? ` \u2192 ${job.path}` : ""
			toast(`Saved ${job.filename}${where}`, "ok")
			if (job.warnings?.length) toast(job.warnings[0], "info")
			void refresh()
			break
		}

		case MSG.JOB_ERROR: {
			clearJob(job)
			if (job.code === FailureCode.CANCELLED) toast("Download cancelled", "info")
			else toast(job.message || "Download failed", job.code === FailureCode.DRM_PROTECTED ? "warn" : "error")
			void refresh()
			break
		}
	}
})

/** @param {Object} job */
function clearJob(job) {
	const key = jobKeys.get(job.jobId) ?? jobKey(job.entryId, job.variantIndex)
	activeJobs.delete(key)
	jobKeys.delete(job.jobId)
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

/**
 * Report companion availability in the footer, so "why did this fall back to
 * ffmpeg" and "is the host installed" are answerable without devtools.
 */
async function showCompanionStatus() {
	const res = await send({ type: MSG.COMPANION_PROBE })
	if (!res.ok) return

	statusEl.textContent =
		res.companion?.state === "ready"
			? `HLS, DASH and progressive ready \u00b7 ${res.summary}`
			: `HLS, DASH and progressive ready \u00b7 ${res.summary} (in-browser only)`
}

async function init() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
	if (!tab || !Number.isInteger(tab.id)) {
		statusEl.textContent = "No active tab"
		return
	}
	tabId = tab.id
	statusEl.textContent = "HLS, DASH and progressive downloads ready"

	await restoreJobs()
	await refresh()

	// Probing spawns a process when the host exists, so it runs after the list
	// is on screen rather than blocking first paint.
	void showCompanionStatus()
}

void init()
