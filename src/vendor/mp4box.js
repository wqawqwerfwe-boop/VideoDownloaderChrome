/**
 * mp4box.js — minimal ISO base media file format (ISO/IEC 14496-12) reader and
 * fragmented-MP4 writer.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * This is **not** a copy of the npm package `mp4box` / `mp4box.js`. It is a
 * purpose-built module that fills the same role in this project, written from
 * the specification, and deliberately kept small enough to read in one sitting.
 *
 * The reasoning: this extension requests `<all_urls>` host permissions. Pasting
 * a few hundred kilobytes of minified third-party code into that trust boundary
 * — unreadable in review, unpinned, and 95% unused by us — is a worse trade
 * than implementing the ~15 boxes we actually emit. It also keeps the project
 * genuinely buildless: this file is loaded directly by the browser as an ES
 * module, with no bundler and no `node_modules`.
 *
 * What it covers:
 *   WRITE  ftyp, moov(mvhd, trak(tkhd, mdia(mdhd, hdlr, minf(vmhd|smhd, dinf,
 *          stbl(stsd(avc1+avcC | mp4a+esds), stts, stsc, stsz, stco)))), mvex(trex)),
 *          moof(mfhd, traf(tfhd, tfdt, trun)), mdat
 *   READ   generic box walk; init-segment track description; moof/mdat sample
 *          extraction
 *
 * What it does not cover: editing in place, non-fragmented sample tables,
 * fragmented-index (sidx) seeking, subtitle tracks, or any codec whose config
 * box we do not recognise. Unrecognised input is reported, never guessed at —
 * the download engine falls back to the companion ffmpeg host instead of
 * writing a file that does not play.
 *
 * All integers in ISO-BMFF are big-endian.
 *
 * @module vendor/mp4box
 */

const ASCII = new TextEncoder()

/* ================================================================== *
 * Byte primitives
 * ================================================================== */

/**
 * @param {Array<Uint8Array>} chunks
 * @returns {Uint8Array}
 */
export function concat(chunks) {
	let total = 0
	for (const chunk of chunks) total += chunk.byteLength
	const out = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.byteLength
	}
	return out
}

/** @param {...number} values */
function u8(...values) {
	return new Uint8Array(values)
}

/** @param {number} n */
function u16(n) {
	const out = new Uint8Array(2)
	new DataView(out.buffer).setUint16(0, n & 0xffff)
	return out
}

/** @param {number} n */
function u32(n) {
	const out = new Uint8Array(4)
	new DataView(out.buffer).setUint32(0, n >>> 0)
	return out
}

/**
 * 64-bit big-endian. Split rather than using BigInt so this stays cheap in the
 * hot path; media decode times never approach 2^53.
 * @param {number} n
 */
function u64(n) {
	const out = new Uint8Array(8)
	const view = new DataView(out.buffer)
	view.setUint32(0, Math.floor(n / 4294967296) >>> 0)
	view.setUint32(4, n % 4294967296 >>> 0)
	return out
}

/** @param {number} count */
function zeros(count) {
	return new Uint8Array(count)
}

/** @param {string} type */
function fourcc(type) {
	if (type.length !== 4) throw new Error(`Box type must be 4 characters, got "${type}"`)
	return ASCII.encode(type)
}

/**
 * Build a box: 4-byte size, 4-byte type, payload.
 * @param {string} type
 * @param {...Uint8Array} payload
 */
function box(type, ...payload) {
	const body = concat(payload)
	const out = new Uint8Array(8 + body.byteLength)
	new DataView(out.buffer).setUint32(0, out.byteLength)
	out.set(fourcc(type), 4)
	out.set(body, 8)
	return out
}

/**
 * Build a FullBox: box whose payload starts with a 1-byte version and 3-byte
 * flags field.
 * @param {string} type
 * @param {number} version
 * @param {number} flags
 * @param {...Uint8Array} payload
 */
function fullBox(type, version, flags, ...payload) {
	return box(type, u8(version & 0xff), u8((flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...payload)
}

/** Identity transform matrix, 3x3 fixed-point, as tkhd/mvhd expect it. */
const UNITY_MATRIX = concat([
	u32(0x00010000),
	u32(0),
	u32(0),
	u32(0),
	u32(0x00010000),
	u32(0),
	u32(0),
	u32(0),
	u32(0x40000000),
])

/** trun sample_flags: sample_depends_on=2 (I-frame), is_non_sync=0. */
export const SAMPLE_FLAG_SYNC = 0x02000000
/** trun sample_flags: sample_depends_on=1 (not an I-frame), is_non_sync=1. */
export const SAMPLE_FLAG_NON_SYNC = 0x01010000

/* ================================================================== *
 * Writer — initialisation segment (ftyp + moov)
 * ================================================================== */

function ftyp() {
	return box("ftyp", fourcc("isom"), u32(0x200), fourcc("isom"), fourcc("iso2"), fourcc("avc1"), fourcc("mp41"))
}

/**
 * @param {number} timescale
 * @param {number} duration in `timescale` units; 0 is legal and means "unknown"
 * @param {number} nextTrackId
 */
function mvhd(timescale, duration, nextTrackId) {
	return fullBox(
		"mvhd",
		0,
		0,
		u32(0), // creation_time
		u32(0), // modification_time
		u32(timescale),
		u32(duration),
		u32(0x00010000), // rate 1.0
		u16(0x0100), // volume 1.0
		u16(0), // reserved
		zeros(8), // reserved
		UNITY_MATRIX,
		zeros(24), // pre_defined
		u32(nextTrackId)
	)
}

/**
 * @param {{ id: number, kind: string, width?: number, height?: number }} track
 * @param {number} duration in movie timescale
 */
function tkhd(track, duration) {
	const isVideo = track.kind === "video"
	return fullBox(
		"tkhd",
		0,
		0x000003, // track_enabled | track_in_movie
		u32(0), // creation_time
		u32(0), // modification_time
		u32(track.id),
		u32(0), // reserved
		u32(duration),
		zeros(8), // reserved
		u16(0), // layer
		u16(0), // alternate_group
		u16(isVideo ? 0 : 0x0100), // volume: 1.0 for audio, 0 for video
		u16(0), // reserved
		UNITY_MATRIX,
		u32(isVideo ? (track.width || 0) << 16 : 0), // 16.16 fixed point
		u32(isVideo ? (track.height || 0) << 16 : 0)
	)
}

/**
 * @param {number} timescale
 * @param {number} duration
 */
function mdhd(timescale, duration) {
	return fullBox(
		"mdhd",
		0,
		0,
		u32(0), // creation_time
		u32(0), // modification_time
		u32(timescale),
		u32(duration),
		u16(0x55c4), // language: "und", packed 5 bits per letter
		u16(0) // pre_defined
	)
}

/** @param {string} kind */
function hdlr(kind) {
	const handler = kind === "video" ? "vide" : "soun"
	const name = kind === "video" ? "VideoHandler" : "SoundHandler"
	return fullBox(
		"hdlr",
		0,
		0,
		u32(0), // pre_defined
		fourcc(handler),
		zeros(12), // reserved
		ASCII.encode(name),
		u8(0) // null terminator
	)
}

function dinf() {
	// A single "url " entry with flags=1 means "data is in this same file".
	return box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)))
}

/**
 * AVC decoder configuration record, built from raw parameter sets.
 * @param {{ sps: Array<Uint8Array>, pps: Array<Uint8Array> }} params
 */
function avcC({ sps, pps }) {
	if (!sps.length) throw new Error("avcC requires at least one SPS")
	const first = sps[0]
	const parts = [
		u8(1), // configurationVersion
		u8(first[1]), // AVCProfileIndication
		u8(first[2]), // profile_compatibility
		u8(first[3]), // AVCLevelIndication
		u8(0xff), // 111111 reserved | lengthSizeMinusOne = 3 (4-byte NAL lengths)
		u8(0xe0 | (sps.length & 0x1f)), // 111 reserved | numOfSequenceParameterSets
	]
	for (const set of sps) parts.push(u16(set.byteLength), set)
	parts.push(u8(pps.length & 0xff))
	for (const set of pps) parts.push(u16(set.byteLength), set)
	return box("avcC", ...parts)
}

/**
 * MPEG-4 elementary stream descriptor wrapping an AudioSpecificConfig.
 * Descriptor lengths use the 7-bits-plus-continuation-bit encoding; a single
 * byte is valid and sufficient for an AAC config.
 * @param {Uint8Array} audioSpecificConfig
 */
function esds(audioSpecificConfig) {
	const descriptor = (tag, payload) => concat([u8(tag), u8(payload.byteLength), payload])

	const decoderSpecific = descriptor(0x05, audioSpecificConfig)
	const decoderConfig = descriptor(
		0x04,
		concat([
			u8(0x40), // objectTypeIndication: MPEG-4 Audio
			u8(0x15), // streamType 5 (audio) << 2 | upStream 0 << 1 | reserved 1
			u8(0, 0, 0), // bufferSizeDB — 0 means "unspecified"
			u32(0), // maxBitrate
			u32(0), // avgBitrate
			decoderSpecific,
		])
	)
	const slConfig = descriptor(0x06, u8(0x02)) // predefined: MP4 timestamps
	const esDescriptor = descriptor(0x03, concat([u16(0), u8(0), decoderConfig, slConfig]))

	return fullBox("esds", 0, 0, esDescriptor)
}

/**
 * Build an AudioSpecificConfig (ISO/IEC 14496-3) for AAC.
 * 5 bits object type, 4 bits sampling frequency index, 4 bits channel config.
 * @param {{ audioObjectType: number, samplingFrequencyIndex: number, channelCount: number }} audio
 */
export function audioSpecificConfig({ audioObjectType, samplingFrequencyIndex, channelCount }) {
	return u8(
		((audioObjectType & 0x1f) << 3) | ((samplingFrequencyIndex & 0x0e) >> 1),
		((samplingFrequencyIndex & 0x01) << 7) | ((channelCount & 0x0f) << 3)
	)
}

/**
 * VisualSampleEntry. The fixed portion is 78 bytes before any child boxes;
 * readers rely on that exact layout, so the field order here is load-bearing.
 * @param {Object} track
 */
function avc1(track) {
	const config = track.avcCBox ? track.avcCBox : avcC({ sps: track.sps || [], pps: track.pps || [] })
	const compressorName = new Uint8Array(32) // 1 length byte + 31 bytes, all zero = unnamed
	return box(
		"avc1",
		zeros(6), // reserved
		u16(1), // data_reference_index
		u16(0), // pre_defined
		u16(0), // reserved
		zeros(12), // pre_defined[3]
		u16(track.width || 0),
		u16(track.height || 0),
		u32(0x00480000), // horizresolution 72 dpi
		u32(0x00480000), // vertresolution 72 dpi
		u32(0), // reserved
		u16(1), // frame_count
		compressorName,
		u16(0x0018), // depth: colour with no alpha
		u16(0xffff), // pre_defined = -1
		config
	)
}

/**
 * AudioSampleEntry. Fixed portion is 28 bytes before child boxes.
 * @param {Object} track
 */
function mp4a(track) {
	const config = track.esdsBox
		? track.esdsBox
		: esds(
				audioSpecificConfig({
					audioObjectType: track.audioObjectType || 2,
					samplingFrequencyIndex: track.samplingFrequencyIndex || 4,
					channelCount: track.channelCount || 2,
				})
			)
	return box(
		"mp4a",
		zeros(6), // reserved
		u16(1), // data_reference_index
		zeros(8), // version, revision, vendor — all reserved
		u16(track.channelCount || 2),
		u16(16), // samplesize
		u16(0), // pre_defined
		u16(0), // reserved
		// samplerate is 16.16 fixed point. Rates above 65535 cannot be expressed
		// here; the authoritative value lives in mdhd's timescale regardless.
		u32(((track.sampleRate || 44100) & 0xffff) << 16),
		config
	)
}

/** @param {Object} track */
function stbl(track) {
	const entry = track.kind === "video" ? avc1(track) : mp4a(track)
	return box(
		"stbl",
		fullBox("stsd", 0, 0, u32(1), entry),
		// A fragmented file carries no samples in the movie box, so every sample
		// table here is legally and necessarily empty.
		fullBox("stts", 0, 0, u32(0)),
		fullBox("stsc", 0, 0, u32(0)),
		fullBox("stsz", 0, 0, u32(0), u32(0)),
		fullBox("stco", 0, 0, u32(0))
	)
}

/** @param {Object} track */
function minf(track) {
	const header =
		track.kind === "video"
			? fullBox("vmhd", 0, 1, u16(0), zeros(6)) // graphicsmode, opcolor
			: fullBox("smhd", 0, 0, u16(0), u16(0)) // balance, reserved
	return box("minf", header, dinf(), stbl(track))
}

/** @param {Object} track */
function trak(track) {
	return box(
		"trak",
		tkhd(track, 0),
		box("mdia", mdhd(track.timescale, 0), hdlr(track.kind), minf(track))
	)
}

/** @param {Array<Object>} tracks */
function mvex(tracks) {
	return box(
		"mvex",
		...tracks.map((track) =>
			fullBox(
				"trex",
				0,
				0,
				u32(track.id),
				u32(1), // default_sample_description_index
				u32(0), // default_sample_duration
				u32(0), // default_sample_size
				u32(0) // default_sample_flags
			)
		)
	)
}

/**
 * Build a complete initialisation segment: `ftyp` + `moov`.
 *
 * A video track is described either by raw parameter sets (`sps`/`pps`, the
 * MPEG-TS path) or by a verbatim `avcC` box lifted from a source init segment
 * (`avcCBox`, the fMP4 path). Audio likewise takes either explicit AAC
 * parameters or a verbatim `esds` box. Re-emitting the original config box byte
 * for byte is the safest option when remuxing, since it preserves details we do
 * not model.
 *
 * @param {Array<{
 *   id: number,
 *   kind: "video"|"audio",
 *   timescale: number,
 *   width?: number,
 *   height?: number,
 *   sps?: Array<Uint8Array>,
 *   pps?: Array<Uint8Array>,
 *   avcCBox?: Uint8Array,
 *   channelCount?: number,
 *   sampleRate?: number,
 *   audioObjectType?: number,
 *   samplingFrequencyIndex?: number,
 *   esdsBox?: Uint8Array
 * }>} tracks
 * @param {{ movieTimescale?: number }} [options]
 * @returns {Uint8Array}
 */
export function buildInitSegment(tracks, { movieTimescale = 1000 } = {}) {
	if (!tracks.length) throw new Error("buildInitSegment requires at least one track")
	const maxId = tracks.reduce((acc, track) => Math.max(acc, track.id), 0)
	return concat([ftyp(), box("moov", mvhd(movieTimescale, 0, maxId + 1), ...tracks.map(trak), mvex(tracks))])
}

/* ================================================================== *
 * Writer — media segment (moof + mdat)
 * ================================================================== */

/**
 * @param {number} sequenceNumber
 * @param {Array<Object>} tracks
 * @param {Array<number>} dataOffsets absolute offsets into the segment, one per track
 */
function moof(sequenceNumber, tracks, dataOffsets) {
	const trafs = tracks.map((track, index) => {
		const samples = track.samples
		const entries = [u32(samples.length), u32(dataOffsets[index])]
		for (const sample of samples) {
			entries.push(
				u32(sample.duration),
				u32(sample.data.byteLength),
				u32(sample.isSync ? SAMPLE_FLAG_SYNC : SAMPLE_FLAG_NON_SYNC),
				// trun version 0 declares this field unsigned, so a negative
				// composition offset must be clamped rather than wrapped. Version 1
				// would allow signed values but is less widely accepted.
				u32(Math.max(0, Math.round(sample.cts || 0)))
			)
		}

		return box(
			"traf",
			// 0x020000 = default-base-is-moof: sample offsets are relative to the
			// start of this moof, which is what makes a segment self-contained.
			fullBox("tfhd", 0, 0x020000, u32(track.id)),
			fullBox("tfdt", 1, 0, u64(track.baseMediaDecodeTime || 0)),
			// 0x000f01 = data-offset | sample-duration | sample-size | sample-flags
			//            | sample-composition-time-offset, all present per sample.
			fullBox("trun", 0, 0x000f01, ...entries)
		)
	})

	return box("moof", fullBox("mfhd", 0, 0, u32(sequenceNumber)), ...trafs)
}

/**
 * Build one `moof` + `mdat` pair.
 *
 * Each `trun`'s `data_offset` has to point at that track's bytes inside the
 * `mdat` that follows, but the offset depends on the size of the `moof` that
 * contains it. Rather than back-patching bytes in place, the `moof` is built
 * once with placeholder offsets purely to measure it — the fields are
 * fixed-width, so the second build is byte-identical in length — and then
 * rebuilt with the real values.
 *
 * @param {{
 *   sequenceNumber: number,
 *   tracks: Array<{
 *     id: number,
 *     baseMediaDecodeTime: number,
 *     samples: Array<{ data: Uint8Array, duration: number, isSync?: boolean, cts?: number }>
 *   }>
 * }} args
 * @returns {Uint8Array}
 */
export function buildMediaSegment({ sequenceNumber, tracks }) {
	const active = tracks.filter((track) => track.samples?.length)
	if (!active.length) return new Uint8Array(0)

	const placeholder = active.map(() => 0)
	const moofSize = moof(sequenceNumber, active, placeholder).byteLength

	// mdat payload starts 8 bytes after the mdat box begins.
	let cursor = moofSize + 8
	const offsets = []
	for (const track of active) {
		offsets.push(cursor)
		for (const sample of track.samples) cursor += sample.data.byteLength
	}

	const payload = []
	for (const track of active) for (const sample of track.samples) payload.push(sample.data)

	return concat([moof(sequenceNumber, active, offsets), box("mdat", ...payload)])
}

/* ================================================================== *
 * Reader
 * ================================================================== */

/**
 * Walk the boxes in a byte range. Handles all three size encodings: a 32-bit
 * size, `1` meaning "a 64-bit size follows", and `0` meaning "extends to the
 * end of the enclosing box".
 *
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @returns {Generator<{ type: string, start: number, size: number, body: Uint8Array }>}
 */
export function* walk(bytes, start = 0, end = bytes.byteLength) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let offset = start

	while (offset + 8 <= end) {
		let size = view.getUint32(offset)
		const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
		let headerSize = 8

		if (size === 1) {
			if (offset + 16 > end) return
			size = view.getUint32(offset + 8) * 4294967296 + view.getUint32(offset + 12)
			headerSize = 16
		} else if (size === 0) {
			size = end - offset
		}

		// A size that runs past the buffer means truncated or corrupt input.
		// Stop cleanly instead of throwing; callers treat a missing box as
		// "unrecognised" and fall back.
		if (size < headerSize || offset + size > end) return

		yield { type, start: offset, size, body: bytes.subarray(offset + headerSize, offset + size) }
		offset += size
	}
}

/**
 * Find the first box of a given type at this level.
 * @param {Uint8Array} bytes
 * @param {string} type
 */
export function findBox(bytes, type) {
	for (const found of walk(bytes)) if (found.type === type) return found
	return null
}

/**
 * Find every box of a given type at this level.
 * @param {Uint8Array} bytes
 * @param {string} type
 */
export function findBoxes(bytes, type) {
	const out = []
	for (const found of walk(bytes)) if (found.type === type) out.push(found)
	return out
}

/**
 * Follow a path of box types, e.g. `["moov", "trak", "mdia"]`.
 * @param {Uint8Array} bytes
 * @param {Array<string>} path
 */
export function findPath(bytes, path) {
	let current = bytes
	let found = null
	for (const type of path) {
		found = findBox(current, type)
		if (!found) return null
		current = found.body
	}
	return found
}

/**
 * Identify a media container from its leading bytes.
 *
 * The engine uses this instead of trusting the URL: CDNs serve `.ts` payloads
 * from `.m4s` paths and vice versa often enough that extension-based dispatch
 * writes corrupt files.
 *
 * @param {Uint8Array} bytes
 * @returns {"mp4"|"ts"|"adts"|"webm"|"id3"|"unknown"}
 */
export function sniffContainer(bytes) {
	if (bytes.byteLength < 4) return "unknown"

	// ISO-BMFF: a recognisable box type at offset 4.
	const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])
	if (["ftyp", "styp", "moov", "moof", "sidx", "free", "skip", "mdat", "emsg"].includes(type)) return "mp4"

	// Matroska / WebM EBML header.
	if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm"

	// ID3v2 tag — common in front of ADTS and raw TS in HLS.
	if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "id3"

	// MPEG-TS: 0x47 sync byte, confirmed one packet later.
	if (bytes[0] === 0x47 && (bytes.byteLength <= 188 || bytes[188] === 0x47)) return "ts"

	// ADTS AAC: 12-bit syncword.
	if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "adts"

	return "unknown"
}

/**
 * Skip an ID3v2 tag if one is present, returning the remaining bytes.
 * @param {Uint8Array} bytes
 */
export function skipId3(bytes) {
	if (bytes.byteLength < 10) return bytes
	if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return bytes
	// Size is 4 syncsafe bytes: 7 significant bits each.
	const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)
	const footer = bytes[5] & 0x10 ? 10 : 0
	const total = 10 + size + footer
	return total < bytes.byteLength ? bytes.subarray(total) : new Uint8Array(0)
}

/**
 * Read the fixed portion of a `tkhd` to get the track id, tolerating both
 * version 0 (32-bit times) and version 1 (64-bit times).
 * @param {Uint8Array} body
 */
function readTkhd(body) {
	const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
	const version = body[0]
	const timesSize = version === 1 ? 8 : 4
	const idOffset = 4 + timesSize * 2
	if (idOffset + 4 > body.byteLength) return null
	const id = view.getUint32(idOffset)

	// width/height are the last two 32-bit fields of the box, 16.16 fixed point.
	const tail = body.byteLength
	const width = tail >= 8 ? view.getUint32(tail - 8) / 65536 : 0
	const height = tail >= 4 ? view.getUint32(tail - 4) / 65536 : 0
	return { id, width: Math.round(width), height: Math.round(height) }
}

/** @param {Uint8Array} body */
function readMdhd(body) {
	const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
	const version = body[0]
	const offset = version === 1 ? 4 + 16 : 4 + 8
	if (offset + 4 > body.byteLength) return 0
	return view.getUint32(offset)
}

/**
 * Re-wrap a box body as a complete box so it can be re-emitted verbatim.
 * @param {string} type
 * @param {Uint8Array} body
 */
function rebox(type, body) {
	return box(type, body)
}

/**
 * Describe the tracks in a fragmented-MP4 initialisation segment.
 *
 * The returned config boxes (`avcCBox`, `esdsBox`) are complete boxes ready to
 * hand straight back to `buildInitSegment`, which is how a DASH remux preserves
 * codec details this module does not model.
 *
 * @param {Uint8Array} bytes
 * @returns {{
 *   tracks: Array<Object>,
 *   unsupported: Array<{ trackId: number, sampleEntry: string }>
 * }}
 */
export function parseInitSegment(bytes) {
	const moov = findBox(bytes, "moov")
	if (!moov) throw new Error("No moov box: not an initialisation segment")

	const tracks = []
	const unsupported = []

	for (const trakBox of findBoxes(moov.body, "trak")) {
		const tkhdBox = findBox(trakBox.body, "tkhd")
		const mdiaBox = findBox(trakBox.body, "mdia")
		if (!tkhdBox || !mdiaBox) continue

		const header = readTkhd(tkhdBox.body)
		if (!header) continue

		const mdhdBox = findBox(mdiaBox.body, "mdhd")
		const timescale = mdhdBox ? readMdhd(mdhdBox.body) : 0

		const stsdBox = findPath(mdiaBox.body, ["minf", "stbl", "stsd"])
		if (!stsdBox) continue

		// stsd body: version+flags (4), entry_count (4), then sample entries.
		const entry = [...walk(stsdBox.body, 8)][0]
		if (!entry) continue

		const view = new DataView(entry.body.buffer, entry.body.byteOffset, entry.body.byteLength)

		if (entry.type === "avc1" || entry.type === "avc3") {
			// VisualSampleEntry: 78 fixed bytes, then child boxes.
			const config = findBox(entry.body.subarray(78), "avcC")
			if (!config) {
				unsupported.push({ trackId: header.id, sampleEntry: `${entry.type} (no avcC)` })
				continue
			}
			tracks.push({
				id: header.id,
				kind: "video",
				timescale: timescale || 90000,
				width: view.getUint16(24) || header.width,
				height: view.getUint16(26) || header.height,
				avcCBox: rebox("avcC", config.body),
				codec: "avc1",
			})
		} else if (entry.type === "mp4a") {
			// AudioSampleEntry: 28 fixed bytes, then child boxes.
			const config = findBox(entry.body.subarray(28), "esds")
			if (!config) {
				unsupported.push({ trackId: header.id, sampleEntry: "mp4a (no esds)" })
				continue
			}
			tracks.push({
				id: header.id,
				kind: "audio",
				timescale: timescale || 48000,
				channelCount: view.getUint16(16),
				sampleRate: view.getUint32(24) >>> 16,
				esdsBox: rebox("esds", config.body),
				codec: "mp4a",
			})
		} else {
			// hvc1/hev1 (HEVC), av01 (AV1), ac-3, ec-3, Opus, FLAC... all real, none
			// of which this writer can describe. Report so the engine can fall back
			// to ffmpeg rather than emit a file with a lying moov.
			unsupported.push({ trackId: header.id, sampleEntry: entry.type })
		}
	}

	return { tracks, unsupported }
}

/** @param {Uint8Array} body */
function parseTfhd(body) {
	const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
	const flags = (body[1] << 16) | (body[2] << 8) | body[3]
	let offset = 4
	const trackId = view.getUint32(offset)
	offset += 4

	const out = { trackId, flags, defaultDuration: 0, defaultSize: 0, defaultFlags: 0 }
	if (flags & 0x000001) offset += 8 // base_data_offset
	if (flags & 0x000002) offset += 4 // sample_description_index
	if (flags & 0x000008) {
		out.defaultDuration = view.getUint32(offset)
		offset += 4
	}
	if (flags & 0x000010) {
		out.defaultSize = view.getUint32(offset)
		offset += 4
	}
	if (flags & 0x000020) {
		out.defaultFlags = view.getUint32(offset)
		offset += 4
	}
	return out
}

/** @param {Uint8Array} body */
function parseTfdt(body) {
	const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
	return body[0] === 1 ? view.getUint32(4) * 4294967296 + view.getUint32(8) : view.getUint32(4)
}

/**
 * @param {Uint8Array} body
 * @param {{ defaultDuration: number, defaultSize: number, defaultFlags: number }} defaults
 */
function parseTrun(body, defaults) {
	const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
	const version = body[0]
	const flags = (body[1] << 16) | (body[2] << 8) | body[3]
	let offset = 4

	const count = view.getUint32(offset)
	offset += 4

	let dataOffset = null
	if (flags & 0x000001) {
		dataOffset = view.getInt32(offset)
		offset += 4
	}
	let firstSampleFlags = null
	if (flags & 0x000004) {
		firstSampleFlags = view.getUint32(offset)
		offset += 4
	}

	const samples = []
	for (let index = 0; index < count; index++) {
		let duration = defaults.defaultDuration
		let size = defaults.defaultSize
		let sampleFlags = index === 0 && firstSampleFlags !== null ? firstSampleFlags : defaults.defaultFlags
		let cts = 0

		if (flags & 0x000100) {
			duration = view.getUint32(offset)
			offset += 4
		}
		if (flags & 0x000200) {
			size = view.getUint32(offset)
			offset += 4
		}
		if (flags & 0x000400) {
			sampleFlags = view.getUint32(offset)
			offset += 4
		}
		if (flags & 0x000800) {
			// Signed in version 1, unsigned in version 0.
			cts = version === 0 ? view.getUint32(offset) : view.getInt32(offset)
			offset += 4
		}

		// is_non_sync_sample is bit 16 of sample_flags.
		samples.push({ duration, size, cts, isSync: (sampleFlags & 0x00010000) === 0 })
	}

	return { samples, dataOffset }
}

/**
 * Pull samples back out of a fragmented-MP4 media segment.
 *
 * Sample bytes are located by `trun.data_offset` relative to the start of the
 * enclosing `moof` — correct whenever `default-base-is-moof` is set, which is
 * effectively universal for DASH and HLS fMP4. If the offset is missing or
 * lands outside the segment's `mdat`, this falls back to reading samples
 * sequentially from the start of the `mdat` payload, which is how every real
 * muxer lays them out anyway.
 *
 * @param {Uint8Array} bytes one complete media segment (may contain several moof/mdat pairs)
 * @returns {Map<number, Array<{ data: Uint8Array, duration: number, cts: number, isSync: boolean, baseMediaDecodeTime: number }>>}
 *   samples grouped by track id, in decode order
 */
export function extractFragmentSamples(bytes) {
	/** @type {Map<number, Array<Object>>} */
	const byTrack = new Map()
	const boxes = [...walk(bytes)]

	for (let index = 0; index < boxes.length; index++) {
		const moofBox = boxes[index]
		if (moofBox.type !== "moof") continue

		// The mdat belonging to this moof is the next mdat box.
		let mdatBox = null
		for (let scan = index + 1; scan < boxes.length; scan++) {
			if (boxes[scan].type === "mdat") {
				mdatBox = boxes[scan]
				break
			}
			if (boxes[scan].type === "moof") break
		}
		if (!mdatBox) continue

		const mdatStart = mdatBox.start + (mdatBox.size - mdatBox.body.byteLength)
		const mdatEnd = mdatBox.start + mdatBox.size
		let sequential = mdatStart

		for (const trafBox of findBoxes(moofBox.body, "traf")) {
			const tfhdBox = findBox(trafBox.body, "tfhd")
			if (!tfhdBox) continue
			const tfhd = parseTfhd(tfhdBox.body)

			const tfdtBox = findBox(trafBox.body, "tfdt")
			const baseMediaDecodeTime = tfdtBox ? parseTfdt(tfdtBox.body) : 0

			const list = byTrack.get(tfhd.trackId) ?? []
			byTrack.set(tfhd.trackId, list)

			for (const trunBox of findBoxes(trafBox.body, "trun")) {
				const { samples, dataOffset } = parseTrun(trunBox.body, tfhd)

				let cursor = dataOffset === null ? sequential : moofBox.start + dataOffset
				const total = samples.reduce((sum, sample) => sum + sample.size, 0)
				if (cursor < mdatStart || cursor + total > mdatEnd) cursor = sequential

				for (const sample of samples) {
					if (cursor + sample.size > mdatEnd) break
					list.push({
						data: bytes.subarray(cursor, cursor + sample.size),
						duration: sample.duration,
						cts: sample.cts,
						isSync: sample.isSync,
						baseMediaDecodeTime,
					})
					cursor += sample.size
				}
				sequential = cursor
			}
		}
	}

	return byTrack
}
