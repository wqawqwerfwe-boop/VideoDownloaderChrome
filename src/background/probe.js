/**
 * Manifest prober.
 *
 * When a playlist or MPD is detected it is fetched and parsed immediately so the
 * popup can show the full quality ladder before the user clicks anything.
 *
 * Fetching from the service worker with host permissions bypasses CORS entirely,
 * so no proxy or offscreen round-trip is needed for this step. `credentials:
 * "include"` keeps session cookies attached for streams the user is signed in to.
 *
 * @module background/probe
 */

import { parsePlaylist, parseMediaPlaylist } from "../engines/hls/parser.js"
import { parseMpd } from "../engines/dash/mpd-parser.js"
import { MediaKind, estimateBytes } from "../shared/media-types.js"
import { patch, get } from "./media-registry.js"
import { createLogger } from "../shared/logger.js"

const log = createLogger("probe")

const FETCH_TIMEOUT_MS = 15_000
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024

/** Prevent duplicate in-flight probes for the same entry. */
const inFlight = new Set()

/**
 * Fetch with a hard timeout. `AbortController` is the only reliable way to bound
 * a fetch; without it a hung CDN keeps the service worker alive indefinitely.
 * @param {string} url
 * @param {number} timeoutMs
 */
async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs)
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			credentials: "include",
			redirect: "follow",
			cache: "no-store",
		})
		if (!res.ok) throw new Error(`HTTP ${res.status}`)

		const declared = Number(res.headers.get("content-length")) || 0
		if (declared > MAX_MANIFEST_BYTES) throw new Error("Manifest too large")

		const text = await res.text()
		if (text.length > MAX_MANIFEST_BYTES) throw new Error("Manifest too large")
		// res.url reflects redirects, and relative URIs must resolve against the final URL.
		return { text, finalUrl: res.url || url }
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Probe one registry entry and write the parsed ladder back into it.
 * @param {number} tabId
 * @param {string} entryId
 * @returns {Promise<Object|null>}
 */
export async function probeEntry(tabId, entryId) {
	const key = `${tabId}:${entryId}`
	if (inFlight.has(key)) return null
	inFlight.add(key)

	try {
		const entry = await get(tabId, entryId)
		if (!entry) return null
		if (entry.kind !== MediaKind.HLS && entry.kind !== MediaKind.DASH) return entry

		await patch(tabId, entryId, { probeState: "probing", probeError: null })

		const { text, finalUrl } = await fetchText(entry.url)

		if (entry.kind === MediaKind.HLS) {
			const parsed = parsePlaylist(text, finalUrl)

			if (parsed.drm?.protected) {
				return await patch(tabId, entryId, {
					probeState: "unsupported",
					drm: parsed.drm,
					probeError: `Protected stream (${parsed.drm.scheme})`,
				})
			}

			if (parsed.type === "master") {
				// Duration lives in the media playlists, so sample the top variant to
				// turn declared bandwidth into a usable size estimate.
				let duration = 0
				let isLive = false
				const probeTarget = parsed.variants[0]
				if (probeTarget) {
					try {
						const sub = await fetchText(probeTarget.url, 10_000)
						const media = parseMediaPlaylist(sub.text, sub.finalUrl)
						duration = media.duration
						isLive = media.isLive
					} catch (err) {
						log.debug("variant sample failed", err?.message)
					}
				}

				const variants = parsed.variants.map((v, i) => ({
					...v,
					index: i,
					duration,
					estimatedBytes: estimateBytes(v.bandwidth, duration),
				}))

				return await patch(tabId, entryId, {
					probeState: "ready",
					playlistType: "master",
					duration,
					isLive,
					variants,
					audioTracks: parsed.audioRenditions.filter((r) => r.url),
					subtitles: parsed.subtitleRenditions.filter((r) => r.url),
					probeError: null,
				})
			}

			// A bare media playlist is a single implicit quality.
			return await patch(tabId, entryId, {
				probeState: "ready",
				playlistType: "media",
				duration: parsed.duration,
				isLive: parsed.isLive,
				segmentCount: parsed.segments.length,
				encrypted: parsed.segments.some((s) => s.key),
				variants: [
					{
						index: 0,
						url: finalUrl,
						bandwidth: 0,
						duration: parsed.duration,
						segmentCount: parsed.segments.length,
						estimatedBytes: 0,
						needsMux: false,
					},
				],
				probeError: null,
			})
		}

		// DASH
		const mpd = parseMpd(text, finalUrl)
		if (mpd.drm?.protected) {
			return await patch(tabId, entryId, {
				probeState: "unsupported",
				drm: mpd.drm,
				probeError: `Protected stream (${mpd.drm.scheme})`,
			})
		}

		const variants = mpd.variants.map((v, i) => ({
			...v,
			index: i,
			// Segment plans are large; the popup only needs the shape, not the payload.
			segments: undefined,
			estimatedBytes: estimateBytes(v.bandwidth, v.duration || mpd.duration),
		}))

		return await patch(tabId, entryId, {
			probeState: "ready",
			playlistType: "mpd",
			duration: mpd.duration,
			isLive: mpd.isLive,
			variants,
			audioTracks: mpd.audioTracks.map((a) => ({ ...a, segments: undefined })),
			probeError: null,
		})
	} catch (err) {
		const message =
			err?.name === "TimeoutError" || err?.name === "AbortError"
				? "Manifest request timed out"
				: err?.message || "Could not read manifest"
		log.warn(`probe failed: ${message}`)
		return await patch(tabId, entryId, { probeState: "error", probeError: message })
	} finally {
		inFlight.delete(key)
	}
}
