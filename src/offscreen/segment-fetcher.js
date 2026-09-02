/**
 * Segment fetching: bounded-concurrency ordered retrieval, with AES-128
 * decryption for RFC 8216 transport encryption.
 *
 * @module offscreen/segment-fetcher
 */

import { FailureCode, EngineError } from "../shared/messages.js"
import { createLogger } from "../shared/logger.js"

const log = createLogger("fetch")

/** Requirement: never more than four requests in flight. */
export const DEFAULT_CONCURRENCY = 4

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 3

/* ================================================================== *
 * HTTP
 * ================================================================== */

/**
 * `fetch` with a deadline, composed with the job's cancellation signal.
 *
 * @param {string} url
 * @param {{ headers?: Record<string,string>, signal?: AbortSignal, timeoutMs?: number }} options
 */
async function fetchWithDeadline(url, { headers, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	if (signal?.aborted) throw new EngineError(FailureCode.CANCELLED, "Cancelled")

	const controller = new AbortController()
	let timedOut = false

	const onAbort = () => controller.abort()
	signal?.addEventListener("abort", onAbort, { once: true })

	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, timeoutMs)

	try {
		// `credentials: "include"` matters: many CDNs gate segments on the same
		// session cookie the page used. `no-store` avoids serving a stale segment
		// from the HTTP cache mid-assembly.
		return await fetch(url, {
			credentials: "include",
			cache: "no-store",
			redirect: "follow",
			headers,
			signal: controller.signal,
		})
	} catch (error) {
		if (timedOut) throw new EngineError(FailureCode.NETWORK_TIMEOUT, `Timed out after ${timeoutMs} ms`, { cause: error })
		if (signal?.aborted) throw new EngineError(FailureCode.CANCELLED, "Cancelled")
		// A TypeError from fetch with no response is the shape a blocked
		// cross-origin read takes; the browser deliberately withholds detail.
		throw new EngineError(FailureCode.CORS_BLOCKED, `Blocked or unreachable: ${describeUrl(url)}`, { cause: error })
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener("abort", onAbort)
	}
}

/** Host + last path element, for messages that should not leak query tokens. */
function describeUrl(url) {
	try {
		const parsed = new URL(url)
		const name = parsed.pathname.split("/").filter(Boolean).pop() || parsed.pathname
		return `${parsed.host}/${name}`
	} catch {
		return url.slice(0, 80)
	}
}

/** 4xx responses will not change on retry, apart from these two. */
function isRetryableStatus(status) {
	return status === 408 || status === 429 || status >= 500
}

/**
 * Fetch one resource with retries and exponential backoff.
 *
 * @param {string} url
 * @param {{ rangeHeader?: string|null, signal?: AbortSignal, retries?: number, timeoutMs?: number }} options
 * @returns {Promise<Uint8Array>}
 */
export async function fetchBytes(url, { rangeHeader, signal, retries = DEFAULT_RETRIES, timeoutMs } = {}) {
	const headers = rangeHeader ? { Range: rangeHeader } : undefined
	let lastError = null

	for (let attempt = 0; attempt <= retries; attempt++) {
		if (signal?.aborted) throw new EngineError(FailureCode.CANCELLED, "Cancelled")

		try {
			const response = await fetchWithDeadline(url, { headers, signal, timeoutMs })

			if (!response.ok) {
				const error = new EngineError(
					response.status === 403 || response.status === 401 ? FailureCode.CORS_BLOCKED : FailureCode.SEGMENT_FAILED,
					`HTTP ${response.status} for ${describeUrl(url)}`
				)
				if (!isRetryableStatus(response.status) || attempt === retries) throw error
				lastError = error
			} else {
				return new Uint8Array(await response.arrayBuffer())
			}
		} catch (error) {
			// Cancellation and DRM refusals are terminal; retrying is pointless.
			if (error instanceof EngineError && error.code === FailureCode.CANCELLED) throw error
			if (attempt === retries) throw error
			lastError = error
		}

		// 300ms, 600ms, 1200ms...
		const backoff = 300 * Math.pow(2, attempt)
		log.debug(`retry ${attempt + 1}/${retries} in ${backoff}ms: ${describeUrl(url)}`)
		await sleep(backoff, signal)
	}

	throw lastError ?? new EngineError(FailureCode.SEGMENT_FAILED, `Failed: ${describeUrl(url)}`)
}

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms)
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer)
				reject(new EngineError(FailureCode.CANCELLED, "Cancelled"))
			},
			{ once: true }
		)
	})
}

/* ================================================================== *
 * AES-128 (RFC 8216 section 5.2)
 * ================================================================== */

/**
 * Parse an `IV=0x...` attribute into 16 bytes.
 * @param {string} raw
 */
function parseIv(raw) {
	const hex = raw.trim().replace(/^0x/i, "")
	const padded = hex.padStart(32, "0").slice(-32)
	const out = new Uint8Array(16)
	for (let index = 0; index < 16; index++) {
		out[index] = parseInt(padded.slice(index * 2, index * 2 + 2), 16) || 0
	}
	return out
}

/**
 * When `EXT-X-KEY` omits IV, the IV is the segment's media sequence number as
 * a 128-bit big-endian integer (RFC 8216 section 5.2).
 * @param {number} sequence
 */
function ivFromSequence(sequence) {
	const out = new Uint8Array(16)
	const view = new DataView(out.buffer)
	view.setUint32(8, Math.floor(sequence / 4294967296) >>> 0)
	view.setUint32(12, sequence % 4294967296 >>> 0)
	return out
}

/**
 * Caches key material by URL so a 3000-segment playlist fetches each key once,
 * and so concurrent segments share a single in-flight request.
 */
export class KeyStore {
	/** @param {{ signal?: AbortSignal }} [options] */
	constructor({ signal } = {}) {
		/** @type {Map<string, Promise<CryptoKey>>} */
		this.keys = new Map()
		this.signal = signal
	}

	/** @param {string} url */
	get(url) {
		const existing = this.keys.get(url)
		if (existing) return existing

		const pending = (async () => {
			const raw = await fetchBytes(url, { signal: this.signal })
			if (raw.byteLength !== 16) {
				throw new EngineError(
					FailureCode.SEGMENT_FAILED,
					`AES-128 key must be 16 bytes, received ${raw.byteLength}`
				)
			}
			// `encrypt` is needed too: the unpadded-tail workaround below has to
			// construct one ciphertext block.
			return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt", "encrypt"])
		})()

		this.keys.set(url, pending)
		return pending
	}
}

/**
 * Decrypt an AES-128-CBC segment.
 *
 * WebCrypto's AES-CBC always validates and strips PKCS#7 padding, and rejects
 * anything else with a bare `OperationError`. Some packagers emit a final block
 * that is not padded that way, which would make every such stream fail.
 *
 * Rather than ship a JavaScript AES implementation for that case, the fallback
 * appends one synthetic ciphertext block: CBC-encrypting a block of sixteen
 * `0x10` bytes (a full, valid PKCS#7 pad) using the segment's last ciphertext
 * block as the IV produces exactly the block WebCrypto expects to find. It then
 * strips that block and returns every real byte untouched.
 *
 * @param {Uint8Array} bytes
 * @param {CryptoKey} key
 * @param {Uint8Array} iv
 * @returns {Promise<Uint8Array>}
 */
export async function decryptAes128(bytes, key, iv) {
	// CBC operates on whole blocks; a ragged tail cannot be ciphertext.
	const usable = bytes.byteLength - (bytes.byteLength % 16)
	if (usable === 0) return new Uint8Array(0)
	const body = usable === bytes.byteLength ? bytes : bytes.subarray(0, usable)

	try {
		return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, body))
	} catch {
		const lastBlock = body.subarray(body.byteLength - 16)
		const fullPad = new Uint8Array(16).fill(16)

		// CBC-encrypt yields E(P xor IV) for the first block, which is precisely
		// the ciphertext block that decrypts to a full pad in this chain.
		const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: lastBlock }, key, fullPad))
		const padBlock = encrypted.subarray(0, 16)

		const extended = new Uint8Array(body.byteLength + 16)
		extended.set(body, 0)
		extended.set(padBlock, body.byteLength)

		try {
			return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, extended))
		} catch (error) {
			throw new EngineError(FailureCode.SEGMENT_FAILED, "AES-128 decryption failed; the key may be wrong", {
				cause: error,
			})
		}
	}
}

/* ================================================================== *
 * Ordered, bounded-concurrency retrieval
 * ================================================================== */

/**
 * Fetch (and decrypt) segments with at most `concurrency` requests in flight,
 * yielding results in playlist order.
 *
 * The window is the point of this function. A plain worker pool also honours a
 * concurrency cap, but if segment 0 is slow the other workers keep claiming
 * later segments and their completed buffers pile up waiting for their turn to
 * be written - unbounded memory growth on exactly the input where memory is
 * already the constraint. Capping lookahead at the concurrency limit keeps peak
 * buffering at roughly four segments while still overlapping every request.
 *
 * @param {Array<{ url: string, byteRange?: { header: string }|null, key?: { method: string, url: string, iv: string|null }|null, seq?: number }>} segments
 * @param {{ concurrency?: number, signal?: AbortSignal, keyStore?: KeyStore, timeoutMs?: number, retries?: number }} options
 * @returns {AsyncGenerator<{ index: number, bytes: Uint8Array }>}
 */
export async function* fetchOrdered(segments, options = {}) {
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
	const { signal, timeoutMs, retries } = options
	const keyStore = options.keyStore ?? new KeyStore({ signal })

	/** @type {Map<number, Promise<Uint8Array>>} */
	const inFlight = new Map()

	const launch = (index) => {
		if (index >= segments.length || inFlight.has(index)) return
		inFlight.set(index, loadSegment(segments[index], { signal, keyStore, timeoutMs, retries }))
	}

	for (let index = 0; index < Math.min(concurrency, segments.length); index++) launch(index)

	try {
		for (let next = 0; next < segments.length; next++) {
			const pending = inFlight.get(next)
			if (!pending) throw new EngineError(FailureCode.UNKNOWN, `Segment ${next} was never scheduled`)

			const bytes = await pending
			inFlight.delete(next)

			// Refill only after a slot is consumed, which is what bounds the window.
			launch(next + concurrency)

			yield { index: next, bytes }
		}
	} finally {
		// Never leave rejected promises unobserved; an unhandled rejection in an
		// offscreen document is logged as an extension error.
		for (const pending of inFlight.values()) pending.catch(() => {})
		inFlight.clear()
	}
}

/**
 * @param {Object} segment
 * @param {{ signal?: AbortSignal, keyStore: KeyStore, timeoutMs?: number, retries?: number }} options
 * @returns {Promise<Uint8Array>}
 */
export async function loadSegment(segment, { signal, keyStore, timeoutMs, retries }) {
	const bytes = await fetchBytes(segment.url, {
		rangeHeader: segment.byteRange?.header ?? null,
		signal,
		timeoutMs,
		retries,
	})

	const key = segment.key
	if (!key || key.method !== "AES-128" || !key.url) return bytes

	const cryptoKey = await keyStore.get(key.url)
	const iv = key.iv ? parseIv(key.iv) : ivFromSequence(segment.seq ?? 0)
	return decryptAes128(bytes, cryptoKey, iv)
}
