/**
 * Integration harness (not shipped): stubs the chrome.* surface the download
 * engine touches, then drives a Sample-AES job through the cascade in two
 * modes, selected by argv[1]:
 *
 *   direct  - companion probe fails (not installed) -> capture handoff anyway
 *   host    - companion replies requires_capture -> capture handoff
 *
 * Usage: node tools/capture-flow-harness.mjs direct|host
 */

const mode = process.argv[2] || "direct"

/* --------------------------------------------------------------- */
/* chrome stub                                                      */
/* --------------------------------------------------------------- */

const store = {} // backing for chrome.storage.session
const sentMessages = []
const createdDocuments = []
const state = {
	offscreenDocs: [], // [{ documentUrl }]
	nativePingReply: null,
	nativeDownloadReply: null,
}

/** Minimal chrome.runtime.Port for exercising the connectNative transport. */
function makePort() {
	const listeners = { message: [], disconnect: [] }
	return {
		postMessage: (payload) => {
			if (payload?.action === "download") {
				// The real host replies asynchronously over the same pipe.
				queueMicrotask(() => {
					for (const fn of listeners.message) fn(state.nativeDownloadReply)
				})
			}
		},
		onMessage: { addListener: (fn) => listeners.message.push(fn) },
		onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
		disconnect: () => {},
	}
}

globalThis.chrome = {
	storage: {
		session: {
			get: async (key) => ({ [key]: store[key] }),
			set: async (obj) => Object.assign(store, obj),
		},
	},
	runtime: {
		getContexts: async () => state.offscreenDocs,
		sendMessage: async (message) => {
			sentMessages.push(message)
			if (message?.type === "capture:prepare-tab") return { ok: true, found: true, duration: 61 }
			return { ok: true, accepted: true }
		},
		sendNativeMessage: async (_name, payload) => {
			if (payload.action === "ping") return state.nativePingReply
			return state.nativeDownloadReply
		},
		connectNative: () => makePort(),
		onMessage: { addListener: () => {} },
	},
	offscreen: {
		createDocument: async (options) => {
			state.offscreenDocs.push({ documentUrl: `chrome-extension://test/${options.url}` })
			createdDocuments.push(options)
		},
		closeDocument: async () => {
			state.offscreenDocs.length = 0
		},
	},
	downloads: {
		onChanged: { addListener: () => {} },
		download: async () => 1,
	},
	declarativeNetRequest: {
		updateSessionRules: async () => {},
	},
	cookies: {
		getAll: async () => [{ name: "session", value: "abc" }],
	},
	tabCapture: {
		getMediaStreamId: async () => "tab-stream-id-1",
	},
	scripting: {
		executeScript: async () => [{ result: { found: true, duration: 61 } }],
	},
}

/* --------------------------------------------------------------- */
/* drive                                                            */
/* --------------------------------------------------------------- */

const engine = await import("../src/background/download-engine.js")
const registry = await import("../src/background/media-registry.js")

const assert = (cond, what) => {
	if (!cond) {
		console.error(`FAIL: ${what}`)
		process.exit(1)
	}
	console.log(`ok: ${what}`)
}

if (mode === "direct") {
	state.nativePingReply = { ok: false, message: "not installed" }
} else if (mode === "port") {
	// Probe over one-shot, download over the port: the production shape.
	state.nativePingReply = {
		ok: true,
		version: "0.5.0",
		protocol: 1,
		ffmpeg: { available: true, version: "7.0" },
		downloadsDir: "/tmp",
	}
	state.nativeDownloadReply = {
		// Deliberately sparse: no `type` field, only status + code, to prove
		// the port listener recognises the handoff however the host spells it.
		status: "requires_capture",
		code: "sample_aes_detected",
		message: "Stream uses Sample-AES encryption. Routing to offscreen recorder.",
	}
} else {
	state.nativePingReply = {
		ok: true,
		version: "0.5.0",
		protocol: 1,
		ffmpeg: { available: true, version: "7.0" },
		downloadsDir: "/tmp",
	}
	state.nativeDownloadReply = {
		type: "requires_capture",
		status: "requires_capture",
		jobId: "(pending)",
		code: "sample_aes_detected",
		message: "Stream uses Sample-AES encryption. Routing to offscreen recorder.",
	}
}

const pageUrl = "https://kinescope.io/video/123456"
const manifestUrl = "https://cdn.kinescope.io/abc/master.m3u8"

const { entry } = await registry.upsert(7, {
	url: manifestUrl,
	kind: "hls",
	title: "Sample-AES test stream",
	pageUrl,
	pageTitle: "Kinescope test",
	duration: 61,
	drm: { protected: true, scheme: "sample-aes" },
	variants: [{ index: 0, height: 1080, width: 1920, bandwidth: 5_000_000, codecs: "avc1.64001f,mp4a.40.2", url: manifestUrl }],
})
assert(entry && entry.id, "registry entry created")

const started = await engine.startJob({ tabId: 7, entryId: entry.id, variantIndex: 0 })
assert(started.ok === true, "startJob accepted a Sample-AES entry")
assert(started.strategy === "capture", `startJob reports capture strategy (got ${started.strategy})`)
assert(started.segmented === true, "startJob reports segmented (progress-tracked)")

// The cascade runs on a detached promise; wait for the CAPTURE_RUN to land.
const deadline = Date.now() + 5000
let captureRun = null
while (Date.now() < deadline && !captureRun) {
	captureRun = sentMessages.find((m) => m.type === "capture:run")
	if (!captureRun) await new Promise((r) => setTimeout(r, 25))
}
assert(captureRun, "CAPTURE_RUN was sent to the offscreen document")
assert(captureRun.jobId === started.jobId, "CAPTURE_RUN carries the jobId")
assert(captureRun.manifestUrl === manifestUrl, "CAPTURE_RUN forwards the manifest link")
assert(captureRun.streamId === "tab-stream-id-1", "CAPTURE_RUN forwards the tab-capture streamId")
assert(captureRun.headers.Referer === pageUrl, "CAPTURE_RUN forwards the page Referer")
assert(String(captureRun.headers.Origin) === "https://kinescope.io", "CAPTURE_RUN forwards the page Origin")
assert(String(captureRun.headers.Cookie).includes("session=abc"), "CAPTURE_RUN forwards the session cookies")
assert(captureRun.quality?.height === 1080, "CAPTURE_RUN forwards the requested quality")
assert(captureRun.filename.endsWith(".mp4"), "CAPTURE_RUN carries the target filename")

const recorderDoc = createdDocuments.find((d) => d.url === "src/offscreen/recorder.html")
assert(recorderDoc, "the recorder document was created")
assert(
	recorderDoc.reasons.includes("USER_MEDIA"),
	`recorder document created with USER_MEDIA reason (got ${JSON.stringify(recorderDoc.reasons)})`
)
assert(recorderDoc.justification === "Recording decrypted streaming layers", "recorder justification matches the brief")

const jobs = await engine.listJobs()
const job = jobs.find((j) => j.jobId === started.jobId)
assert(job, "job is tracked")
assert(job.strategy === "capture", `job strategy is capture (got ${job.strategy})`)
assert(job.phase === "recording", `job phase is recording (got ${job.phase})`)

// Cancel must reach the recorder document, not spin up the engine document.
const cancel = await engine.cancelJob(started.jobId)
assert(cancel.ok === true, "capture job can be cancelled")
await new Promise((r) => setTimeout(r, 50))
const cancelMessage = sentMessages.find((m) => m.type === "engine:cancel" && m.jobId === started.jobId)
assert(cancelMessage, "ENGINE_CANCEL reached the recorder")
assert(
	!createdDocuments.some((d) => d.url === "src/offscreen/offscreen.html"),
	"cancelling a capture never spins up the engine document"
)

// A hard-DRM entry must still be refused outright.
const { entry: drmEntry } = await registry.upsert(7, {
	url: "https://cdn.example.com/widevine/master.m3u8",
	kind: "hls",
	title: "Widevine stream",
	drm: { protected: true, scheme: "widevine" },
})
const refused = await engine.startJob({ tabId: 7, entryId: drmEntry.id, variantIndex: 0 })
assert(refused.ok === false && refused.code === "drm_protected", "hard DRM is still refused")

console.log(`\n${mode} mode: ALL CHECKS PASSED`)
