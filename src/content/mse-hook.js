/**
 * MAIN-world Media Source Extensions hook.
 *
 * Adaptive players attach a `blob:` URL to the <video> element, so the DOM says
 * nothing useful about where the media actually comes from. Patching the MSE
 * surface recovers the real codecs and lets us associate a blob-backed element
 * with the manifest traffic the sniffer already saw.
 *
 * Runs in the page's own JavaScript context (world: MAIN), so it cannot use the
 * chrome.* APIs. It reports upward with window.postMessage; the ISOLATED-world
 * companion relays to the service worker.
 *
 * This is generic instrumentation of a standard web API. It records what the
 * page already chose to fetch; it does not defeat access controls.
 */

;(() => {
	"use strict"

	const CHANNEL = "ovd:mse"
	if (window.__ovdMseHookInstalled) return
	window.__ovdMseHookInstalled = true

	/** blob URL -> { codecs: Set<string>, createdAt: number } */
	const mediaSources = new WeakMap()
	const blobIndex = new Map()

	function report(payload) {
		try {
			window.postMessage({ channel: CHANNEL, ...payload }, "*")
		} catch {
			/* structured-clone failure - ignore */
		}
	}

	/* --- MediaSource.addSourceBuffer: learn the codecs in play --- */
	if (window.MediaSource?.prototype?.addSourceBuffer) {
		const original = MediaSource.prototype.addSourceBuffer
		MediaSource.prototype.addSourceBuffer = function (mimeType) {
			try {
				const record = mediaSources.get(this) ?? { codecs: new Set(), createdAt: Date.now() }
				record.codecs.add(String(mimeType))
				mediaSources.set(this, record)
				report({ kind: "sourcebuffer", mimeType: String(mimeType) })
			} catch {
				/* never break playback */
			}
			return original.apply(this, arguments)
		}
	}

	/* --- URL.createObjectURL: map the blob URL back to its MediaSource --- */
	if (window.URL?.createObjectURL) {
		const original = URL.createObjectURL
		URL.createObjectURL = function (obj) {
			const url = original.apply(this, arguments)
			try {
				if (window.MediaSource && obj instanceof MediaSource) {
					blobIndex.set(url, obj)
					const record = mediaSources.get(obj)
					report({
						kind: "mediasource",
						blobUrl: url,
						codecs: record ? [...record.codecs] : [],
					})
				}
			} catch {
				/* ignore */
			}
			return url
		}
	}

	/* --- fetch / XHR: catch manifest URLs built inside the page --- *
	 * webRequest sees these too, but only the page knows which of them the player
	 * actually treated as a manifest, and in-page redirects can hide the original.
	 */
	const MANIFEST_RE = /\.(m3u8|mpd)(\?|#|$)/i

	if (window.fetch) {
		const original = window.fetch
		window.fetch = function (input, init) {
			try {
				const url = typeof input === "string" ? input : input?.url
				if (url && MANIFEST_RE.test(url)) {
					report({ kind: "manifest", url: new URL(url, location.href).href, via: "fetch" })
				}
			} catch {
				/* ignore */
			}
			return original.apply(this, arguments)
		}
	}

	if (window.XMLHttpRequest?.prototype?.open) {
		const original = XMLHttpRequest.prototype.open
		XMLHttpRequest.prototype.open = function (method, url) {
			try {
				if (typeof url === "string" && MANIFEST_RE.test(url)) {
					report({ kind: "manifest", url: new URL(url, location.href).href, via: "xhr" })
				}
			} catch {
				/* ignore */
			}
			return original.apply(this, arguments)
		}
	}
})()
