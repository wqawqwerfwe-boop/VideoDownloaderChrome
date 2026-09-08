/**
 * Integration harness (not shipped): verifies that the manifest prober keeps
 * the quality ladder for Sample-AES entries (flagged, not blocked) while hard
 * DRM still lands as "unsupported".
 *
 * Usage: node tools/capture-probe-harness.mjs
 */

const store = {}
const fetchLog = []
const playlists = {
	"https://cdn.example.com/master.m3u8": `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.64001f,mp4a.40.2"
v1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
v720.m3u8
`,
	"https://cdn.example.com/v1080.m3u8": `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://cdn.example.com/key",IV=0xdeadbeef
#EXTINF:6.0,
seg0.ts
#EXTINF:6.0,
seg1.ts
#EXT-X-ENDLIST
`,
	"https://drm.example.com/master.m3u8": `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://asset/1",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-STREAM-INF:BANDWIDTH=1000000
v.m3u8
`,
}

globalThis.chrome = {
	storage: {
		session: {
			get: async (key) => ({ [key]: store[key] }),
			set: async (obj) => Object.assign(store, obj),
		},
	},
}
globalThis.fetch = async (url) => {
	fetchLog.push(url)
	const body = playlists[url]
	if (body === undefined) throw new Error(`harness: unexpected fetch ${url}`)
	return { ok: true, status: 200, url, headers: { get: () => null }, text: async () => body }
}

const registry = await import("../src/background/media-registry.js")
const { probeEntry } = await import("../src/background/probe.js")

const assert = (cond, what) => {
	if (!cond) {
		console.error(`FAIL: ${what}`)
		process.exit(1)
	}
	console.log(`ok: ${what}`)
}

// --- Sample-AES: flagged, but the ladder survives ---------------------
const { entry } = await registry.upsert(3, {
	url: "https://cdn.example.com/master.m3u8",
	kind: "hls",
	title: "Kinescope-style stream",
})
await probeEntry(3, entry.id)
const probed = await registry.get(3, entry.id)

assert(probed.probeState === "ready", `sample-aes entry is probe-ready (got ${probed.probeState})`)
assert(probed.drm?.protected === true, "sample-aes entry keeps its drm flag")
assert(probed.drm?.scheme === "sample-aes", "drm scheme is sample-aes")
assert(probed.variants?.length === 2, "the full quality ladder is kept")
assert(probed.variants[0].height === 1080, "variant metadata parsed")

// --- FairPlay-delivered Sample-AES: still refused ---------------------
const { entry: fairplay } = await registry.upsert(3, {
	url: "https://drm.example.com/master.m3u8",
	kind: "hls",
	title: "FairPlay stream",
})
await probeEntry(3, fairplay.id)
const blocked = await registry.get(3, fairplay.id)
assert(blocked.probeState === "unsupported", "FairPlay-delivered Sample-AES is still unsupported")
assert(blocked.drm?.scheme === "fairplay", "FairPlay scheme is named")

console.log("\nprobe mode: ALL CHECKS PASSED")
