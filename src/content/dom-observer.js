/**
 * ISOLATED-world content script.
 *
 * Two jobs:
 *   1. Watch the DOM for <video>/<audio>/<source>/<iframe> nodes the network
 *      layer might have missed: cached media, late hydration, SPA route
 *      changes, and iframes that point straight at a media file.
 *   2. Relay messages from the MAIN-world MSE hook to the service worker,
 *      since that hook has no access to chrome.*.
 *
 * Performance contract (this runs in every frame of every page, so it matters):
 *   - Mutations are never inspected synchronously. They are coalesced and
 *     handled in one idle-time sweep, so a page that rebuilds its DOM in a
 *     tight loop costs one sweep rather than one pass per mutation.
 *   - Only added subtrees are swept. There is exactly one full-document scan,
 *     at startup, plus two cheap re-scans for late-hydrating players.
 *   - attributeFilter keeps us off the firehose of unrelated attribute writes.
 *   - Reported URLs are remembered, so the service worker is woken at most once
 *     per FLUSH_MS and never for a duplicate.
 *   - Every piece of dedupe state is bounded; a long-lived page cannot grow it
 *     without limit.
 *
 * Scope: this observes what the page already loaded. It does not defeat access
 * controls. DRM-protected streams are left to the prober, which reports them as
 * unsupported rather than attempting them.
 */

;(() => {
	"use strict"

	const CHANNEL = "ovd:mse"
	const FLUSH_MS = 400
	const IDLE_TIMEOUT_MS = 250
	const MAX_PENDING = 60
	const MAX_REPORTED = 400
	const MAX_QUEUED_ROOTS = 80
	/** Element budget for the startup shadow-DOM walk. */
	const DEEP_WALK_BUDGET = 1500
	/** Element budget when walking one freshly added subtree. */
	const SMALL_WALK_BUDGET = 150

	if (window.__ovdDomObserverInstalled) return
	window.__ovdDomObserverInstalled = true

	const SELECTOR = "video,audio,source[src],iframe[src]"
	const ATTR_FILTER = ["src", "poster"]
	const MEDIA_EVENTS = ["loadedmetadata", "loadstart", "durationchange"]

	/*
	 * Content scripts declared in the manifest are classic scripts, so
	 * shared/media-types.js cannot be imported here. These patterns are
	 * deliberately narrower than the shared classifier: the background script
	 * re-classifies everything authoritatively using Content-Type, so a false
	 * negative here is cheap and a false positive is not.
	 */
	const HLS_RE = /\.(m3u8|m3u)$/i
	const DASH_RE = /\.mpd$/i
	const PROGRESSIVE_RE = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|flv|wmv|mp3|m4a|ogg|opus|wav|flac)$/i
	const SEGMENT_RE = /\.(ts|m4s|cmfv|cmfa|cmft|fmp4)$|(?:seg|segment|chunk|frag)[-_]?\d{2,}/i
	const UNFETCHABLE_RE = /^(?:blob:|data:|mediasource:|filesystem:|about:|javascript:)/i

	/** @type {Map<string, Object>} */
	const pending = new Map()
	/** Bounded, insertion-ordered FIFO of URLs already sent. */
	const reported = new Set()
	/** Media elements already carrying our listeners. */
	const bound = new WeakSet()
	/** Roots (document + open shadow roots) already under observation. */
	const observedRoots = new WeakSet()
	/** Nodes awaiting an idle sweep. */
	const queuedRoots = []
	/** Codecs learned from the MAIN-world MSE hook. */
	let mseCodecs = []

	let flushTimer = null
	let sweepScheduled = false
	let disposed = false
	/** @type {MutationObserver|null} */
	let observer = null

	const idle =
		typeof window.requestIdleCallback === "function"
			? (fn) => window.requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS })
			: (fn) => setTimeout(fn, 50)

	/* ------------------------------------------------------------------ *
	 * Classification
	 * ------------------------------------------------------------------ */

	function absolute(url) {
		try {
			return new URL(url, location.href).href
		} catch {
			return ""
		}
	}

	/**
	 * @param {string} url
	 * @returns {{ kind: string, container: string }|null} null when the URL is not
	 *   media, is an individual segment, or could never be re-fetched from the
	 *   background context.
	 */
	function classifyUrl(url) {
		if (!url || UNFETCHABLE_RE.test(url)) return null
		let pathname
		try {
			pathname = new URL(url, location.href).pathname
		} catch {
			return null
		}
		if (HLS_RE.test(pathname)) return { kind: "hls", container: "hls" }
		if (DASH_RE.test(pathname)) return { kind: "dash", container: "dash" }
		// Checked after the manifest patterns so a segment-shaped path that is in
		// fact a playlist still wins as a playlist.
		if (SEGMENT_RE.test(pathname)) return null
		const match = PROGRESSIVE_RE.exec(pathname)
		if (match) return { kind: "progressive", container: match[1].toLowerCase() }
		return null
	}

	/* ------------------------------------------------------------------ *
	 * Reporting
	 * ------------------------------------------------------------------ */

	function markReported(url) {
		if (reported.size >= MAX_REPORTED) {
			// Sets iterate in insertion order, so this drops the oldest quarter.
			const drop = Math.ceil(MAX_REPORTED / 4)
			let i = 0
			for (const key of reported) {
				reported.delete(key)
				if (++i >= drop) break
			}
		}
		reported.add(url)
	}

	function queue(item) {
		if (disposed || !item || !item.url) return
		if (reported.has(item.url)) return
		if (pending.size >= MAX_PENDING) return
		pending.set(item.url, item)
		if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
	}

	function flush() {
		flushTimer = null
		if (disposed || pending.size === 0) return
		const items = [...pending.values()]
		pending.clear()
		for (const item of items) markReported(item.url)

		// A reloaded or updated extension invalidates this context: chrome.runtime.id
		// goes undefined and any sendMessage would throw.
		if (!chrome.runtime?.id) {
			dispose()
			return
		}
		try {
			chrome.runtime.sendMessage({ type: "media:observed", items }, () => void chrome.runtime.lastError)
		} catch {
			dispose()
		}
	}

	/* ------------------------------------------------------------------ *
	 * Element inspection
	 * ------------------------------------------------------------------ */

	/**
	 * Attach listeners once so later source swaps re-report without needing a
	 * DOM mutation. Players routinely reassign .src on an existing element.
	 * @param {HTMLMediaElement} el
	 */
	function bind(el) {
		if (bound.has(el)) return
		bound.add(el)
		const onChange = () => {
			if (!disposed) scheduleSweep(el)
		}
		for (const type of MEDIA_EVENTS) {
			try {
				el.addEventListener(type, onChange, { passive: true })
			} catch {
				/* ignore */
			}
		}
	}

	/** @param {HTMLMediaElement} el */
	function inspectMediaElement(el) {
		const title = document.title || ""
		const isVideo = el.tagName === "VIDEO"
		const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined
		const width = isVideo && el.videoWidth ? el.videoWidth : undefined
		const height = isVideo && el.videoHeight ? el.videoHeight : undefined
		const posterAttr = isVideo ? el.getAttribute("poster") : null
		const poster = posterAttr ? absolute(posterAttr) : undefined

		// currentSrc is what is actually playing; the src attribute and any <source>
		// children are what the page declared. Collect all three: a blob: currentSrc
		// (MSE) often sits alongside a usable declared fallback.
		const candidates = []
		if (el.currentSrc) candidates.push(el.currentSrc)
		const srcAttr = el.getAttribute("src")
		if (srcAttr) candidates.push(absolute(srcAttr))
		let sources
		try {
			sources = el.querySelectorAll("source[src]")
		} catch {
			sources = []
		}
		for (const source of sources) {
			const raw = source.getAttribute("src")
			if (raw) candidates.push(absolute(raw))
		}

		for (const url of candidates) {
			const classified = classifyUrl(url)
			if (!classified) continue
			queue({
				url,
				kind: classified.kind,
				container: classified.container,
				mimeType: el.getAttribute("type") || undefined,
				title,
				duration,
				width,
				height,
				poster,
				source: "dom",
			})
		}
	}

	/**
	 * Only iframes whose src *is* a media file are interesting. Ordinary embedded
	 * players are whole documents, and the manifest declares all_frames plus
	 * match_about_blank, so each of those frames already runs its own copy of
	 * this script and reports for itself. Recursing here would double-report and
	 * throw on every cross-origin frame.
	 * @param {HTMLIFrameElement} el
	 */
	function inspectIframe(el) {
		const raw = el.getAttribute("src")
		if (!raw) return
		const url = absolute(raw)
		const classified = classifyUrl(url)
		if (!classified) return
		queue({
			url,
			kind: classified.kind,
			container: classified.container,
			title: document.title || "",
			source: "iframe",
		})
	}

	/** @param {Node} node */
	function inspectNode(node) {
		if (!node || node.nodeType !== 1) return
		switch (/** @type {Element} */ (node).tagName) {
			case "VIDEO":
			case "AUDIO": {
				const el = /** @type {HTMLMediaElement} */ (node)
				bind(el)
				inspectMediaElement(el)
				return
			}
			case "SOURCE": {
				// A <source> only means something through its parent, which owns
				// currentSrc and the metadata.
				const parent = /** @type {Element} */ (node).parentElement
				if (parent && (parent.tagName === "VIDEO" || parent.tagName === "AUDIO")) {
					const el = /** @type {HTMLMediaElement} */ (parent)
					bind(el)
					inspectMediaElement(el)
				}
				return
			}
			case "IFRAME":
				inspectIframe(/** @type {HTMLIFrameElement} */ (node))
				return
			default:
				return
		}
	}

	/* ------------------------------------------------------------------ *
	 * Sweeping
	 * ------------------------------------------------------------------ */

	/**
	 * Inspect a root, its matching descendants, and any open shadow roots beneath
	 * it. Component-based players (LitElement, Stencil, several commercial
	 * embeds) put their <video> inside a shadow root, where a plain document
	 * query cannot see it.
	 *
	 * @param {Document|ShadowRoot|Element} root
	 * @param {number} walkBudget elements to examine while hunting shadow roots
	 */
	function sweep(root, walkBudget) {
		if (disposed || !root) return

		inspectNode(/** @type {any} */ (root))
		try {
			for (const node of root.querySelectorAll(SELECTOR)) inspectNode(node)
		} catch {
			// Detached or otherwise unqueryable root.
			return
		}

		if (walkBudget <= 0) return
		let walker
		try {
			walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
		} catch {
			return
		}
		let budget = walkBudget
		let current = walker.nextNode()
		while (current && budget-- > 0) {
			const shadow = /** @type {Element} */ (current).shadowRoot
			if (shadow && !observedRoots.has(shadow)) {
				observeRoot(shadow)
				// Halve the budget going down so a deeply nested component tree cannot
				// turn one sweep into an unbounded walk.
				sweep(shadow, Math.floor(budget / 2))
			}
			current = walker.nextNode()
		}
	}

	/** @param {Node} node */
	function scheduleSweep(node) {
		if (disposed) return
		if (queuedRoots.length < MAX_QUEUED_ROOTS) queuedRoots.push(node)
		if (sweepScheduled) return
		sweepScheduled = true
		idle(runQueuedSweeps)
	}

	function runQueuedSweeps() {
		sweepScheduled = false
		if (disposed) return
		const roots = queuedRoots.splice(0, queuedRoots.length)
		const seen = new Set()
		for (const root of roots) {
			if (seen.has(root)) continue
			seen.add(root)
			// A node added and removed again before the sweep ran is not worth chasing.
			if (root.isConnected === false) continue
			sweep(root, SMALL_WALK_BUDGET)
		}
	}

	/** @param {Document|ShadowRoot} root */
	function observeRoot(root) {
		if (disposed || !root || !observer || observedRoots.has(root)) return
		observedRoots.add(root)
		try {
			observer.observe(root, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ATTR_FILTER,
			})
		} catch {
			/* ignore */
		}
	}

	/* ------------------------------------------------------------------ *
	 * MSE hook relay
	 * ------------------------------------------------------------------ */

	window.addEventListener(
		"message",
		(event) => {
			if (disposed) return
			// Only trust messages this window posted to itself; any frame can post here.
			if (event.source !== window) return
			const data = event.data
			if (!data || typeof data !== "object" || data.channel !== CHANNEL) return

			if (data.kind === "manifest" && typeof data.url === "string") {
				const classified = classifyUrl(data.url)
				if (!classified) return
				queue({
					url: data.url,
					kind: classified.kind,
					container: classified.container,
					title: document.title || "",
					codecs: mseCodecs.length ? mseCodecs.join(",") : undefined,
					source: data.via === "xhr" ? "mse:xhr" : "mse:fetch",
				})
				return
			}

			// "mediasource" and "sourcebuffer" describe a blob: URL, which has no
			// fetchable address. Keep the codec strings so the next manifest we relay
			// can carry them.
			if (data.kind === "sourcebuffer" && typeof data.mimeType === "string") {
				if (!mseCodecs.includes(data.mimeType)) mseCodecs = [...mseCodecs, data.mimeType].slice(-8)
			} else if (data.kind === "mediasource" && Array.isArray(data.codecs)) {
				mseCodecs = data.codecs.slice(-8)
			}
		},
		false
	)

	/* ------------------------------------------------------------------ *
	 * Lifecycle
	 * ------------------------------------------------------------------ */

	function dispose() {
		if (disposed) return
		disposed = true
		try {
			observer?.disconnect()
		} catch {
			/* ignore */
		}
		observer = null
		if (flushTimer) {
			clearTimeout(flushTimer)
			flushTimer = null
		}
		pending.clear()
		queuedRoots.length = 0
	}

	observer = new MutationObserver((records) => {
		if (disposed) return
		for (const record of records) {
			if (record.type === "attributes") {
				scheduleSweep(record.target)
				continue
			}
			// addedNodes is a live-ish NodeList; the nodeType check is the cheapest
			// possible filter and text nodes dominate on most pages.
			for (const node of record.addedNodes) {
				if (node.nodeType !== 1) continue
				scheduleSweep(node)
			}
		}
	})

	// run_at is document_start, so <body> may not exist yet. Observing `document`
	// itself covers everything that will ever be appended.
	observeRoot(document)

	function initialScan() {
		if (!disposed) sweep(document, DEEP_WALK_BUDGET)
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", initialScan, { once: true })
	} else {
		initialScan()
	}

	// Players that hydrate late, or that attach a shadow root only once their
	// bundle arrives, can appear without a mutation we can attribute. Two fixed
	// re-scans cover that without polling.
	setTimeout(initialScan, 2500)
	setTimeout(initialScan, 8000)

	window.addEventListener("pagehide", dispose, { once: true })
})()
