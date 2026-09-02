/**
 * mux.js — MPEG-2 Transport Stream demuxer and fragmented-MP4 transmuxer.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * This is **not** a copy of the npm package `mux.js`. It is a purpose-built
 * module filling the same role, written from ISO/IEC 13818-1 (transport
 * stream), ISO/IEC 14496-10 (H.264) and ISO/IEC 13818-7 (ADTS AAC), and kept
 * small enough to actually review. See `src/vendor/README.md` for the reasoning.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * HLS still predominantly ships MPEG-2 Transport Stream segments. A `.ts`
 * payload is not an MP4 and cannot be concatenated into one — there is no
 * `moov`, samples are wrapped in 188-byte packets with their own clock, and
 * H.264 arrives as start-code delimited Annex B rather than length-prefixed
 * AVCC. Producing a playable `.mp4` requires demuxing to elementary streams and
 * rewriting with a real sample table. That is this file's entire job:
 *
 *   TS packets → PAT → PMT → PES → elementary streams → samples → fMP4
 *
 * SCOPE
 * -----
 * Handles H.264 video and AAC-LC audio, muxed together or as separate streams,
 * plus bare ADTS AAC segments (audio-only HLS renditions frequently serve
 * `.aac` rather than `.ts`).
 *
 * Everything else is **detected and named**, never guessed at. Unsupported
 * codecs set `fatal`, and the download engine hands the job to the ffmpeg
 * companion host. The alternative — writing an `.mp4` whose `moov` misdescribes
 * its payload — produces a file that looks fine until you try to play it, which
 * is a worse outcome than an honest fallback.
 *
 * @module vendor/mux
 */

import { concat, buildInitSegment, buildMediaSegment, skipId3, sniffContainer } from "./mp4box.js"

/** Transport stream packet size. Fixed by the specification. */
export const TS_PACKET_SIZE = 188

/** ISO/IEC 13818-7 sampling frequency index table. */
export const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

/**
 * PMT `stream_type` registry, limited to what actually turns up in HLS.
 * `supported` reflects what *this module* can transmux, not what is legal.
 */
export const STREAM_TYPES = {
	0x01: { name: "MPEG-1 video", supported: false },
	0x02: { name: "MPEG-2 video", supported: false },
	0x03: { name: "MPEG-1 audio (MP3)", supported: false },
	0x04: { name: "MPEG-2 audio (MP3)", supported: false },
	0x05: { name: "private sections", supported: false, ignorable: true },
	0x06: { name: "PES private data", supported: false, ignorable: true },
	0x0f: { name: "AAC (ADTS)", supported: true, kind: "audio" },
	0x11: { name: "AAC (LATM)", supported: false },
	0x15: { name: "ID3 metadata", supported: false, ignorable: true },
	0x1b: { name: "H.264/AVC", supported: true, kind: "video" },
	0x1c: { name: "AAC (raw, no ADTS)", supported: false },
	0x1f: { name: "H.264 SVC", supported: false },
	0x20: { name: "H.264 MVC", supported: false },
	0x21: { name: "JPEG 2000", supported: false },
	0x24: { name: "H.265/HEVC", supported: false },
	0x27: { name: "H.265/HEVC (layered)", supported: false },
	0x81: { name: "AC-3", supported: false },
	0x87: { name: "E-AC-3", supported: false },
	0x8a: { name: "DTS", supported: false },
	0xea: { name: "VC-1", supported: false },
}

/* ================================================================== *
 * Bit reading (Exp-Golomb)
 * ================================================================== */

/**
 * Bit-level reader with the unsigned/signed Exp-Golomb codes H.264 uses for
 * its parameter sets.
 */
class BitReader {
	/** @param {Uint8Array} bytes */
	constructor(bytes) {
		this.bytes = bytes
		this.byteIndex = 0
		this.bitIndex = 0
	}

	bitsLeft() {
		return (this.bytes.byteLength - this.byteIndex) * 8 - this.bitIndex
	}

	readBit() {
		if (this.byteIndex >= this.bytes.byteLength) return 0
		const bit = (this.bytes[this.byteIndex] >> (7 - this.bitIndex)) & 1
		if (++this.bitIndex === 8) {
			this.bitIndex = 0
			this.byteIndex++
		}
		return bit
	}

	/** @param {number} count */
	readBits(count) {
		let value = 0
		for (let index = 0; index < count; index++) value = value * 2 + this.readBit()
		return value
	}

	/** Unsigned Exp-Golomb. */
	readUe() {
		let leadingZeros = 0
		while (this.bitsLeft() > 0 && this.readBit() === 0) {
			if (++leadingZeros > 31) return 0 // malformed; bail rather than spin
		}
		if (leadingZeros === 0) return 0
		return Math.pow(2, leadingZeros) - 1 + this.readBits(leadingZeros)
	}

	/** Signed Exp-Golomb. */
	readSe() {
		const value = this.readUe()
		return value & 1 ? (value + 1) >> 1 : -(value >> 1)
	}

	/**
	 * Consume a scaling list without storing it. The values do not affect the
	 * geometry we are after, but the bits must be consumed or every field after
	 * them is misread.
	 * @param {number} count
	 */
	skipScalingList(count) {
		let lastScale = 8
		let nextScale = 8
		for (let index = 0; index < count; index++) {
			if (nextScale !== 0) {
				nextScale = (lastScale + this.readSe() + 256) % 256
			}
			lastScale = nextScale === 0 ? lastScale : nextScale
		}
	}
}

/**
 * Strip emulation-prevention bytes: inside a NAL payload the sequence
 * `00 00 03` encodes a literal `00 00`, so the `03` must be removed before the
 * bitstream can be parsed.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function unescapeRbsp(bytes) {
	const out = new Uint8Array(bytes.byteLength)
	let written = 0
	let zeroRun = 0
	for (let index = 0; index < bytes.byteLength; index++) {
		const byte = bytes[index]
		if (zeroRun === 2 && byte === 0x03) {
			zeroRun = 0
			continue
		}
		zeroRun = byte === 0x00 ? zeroRun + 1 : 0
		out[written++] = byte
	}
	return out.subarray(0, written)
}

/** Profiles that carry the extra chroma/scaling-list block in the SPS. */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

/**
 * Parse a Sequence Parameter Set for the geometry the MP4 writer needs.
 *
 * `tkhd` and `avc1` both require real pixel dimensions, and the only place
 * those exist in a transport stream is inside this bitstream. Note the field
 * ordering for High profiles — skipping the chroma block is the classic way to
 * end up with nonsense dimensions.
 *
 * @param {Uint8Array} nal complete SPS NAL unit, including its header byte
 * @returns {{ profileIdc: number, levelIdc: number, width: number, height: number, chromaFormatIdc: number }}
 */
export function parseSps(nal) {
	const rbsp = unescapeRbsp(nal.subarray(1)) // drop the NAL header byte
	const reader = new BitReader(rbsp)

	const profileIdc = reader.readBits(8)
	reader.readBits(8) // constraint flags + reserved
	const levelIdc = reader.readBits(8)
	reader.readUe() // seq_parameter_set_id

	let chromaFormatIdc = 1 // 4:2:0 when not present
	if (HIGH_PROFILES.has(profileIdc)) {
		chromaFormatIdc = reader.readUe()
		if (chromaFormatIdc === 3) reader.readBit() // separate_colour_plane_flag
		reader.readUe() // bit_depth_luma_minus8
		reader.readUe() // bit_depth_chroma_minus8
		reader.readBit() // qpprime_y_zero_transform_bypass_flag
		if (reader.readBit()) {
			// seq_scaling_matrix_present_flag
			const listCount = chromaFormatIdc !== 3 ? 8 : 12
			for (let index = 0; index < listCount; index++) {
				if (reader.readBit()) reader.skipScalingList(index < 6 ? 16 : 64)
			}
		}
	}

	reader.readUe() // log2_max_frame_num_minus4
	const picOrderCntType = reader.readUe()
	if (picOrderCntType === 0) {
		reader.readUe() // log2_max_pic_order_cnt_lsb_minus4
	} else if (picOrderCntType === 1) {
		reader.readBit() // delta_pic_order_always_zero_flag
		reader.readSe() // offset_for_non_ref_pic
		reader.readSe() // offset_for_top_to_bottom_field
		const cycleLength = reader.readUe()
		for (let index = 0; index < cycleLength; index++) reader.readSe()
	}

	reader.readUe() // max_num_ref_frames
	reader.readBit() // gaps_in_frame_num_value_allowed_flag

	const widthInMbs = reader.readUe() + 1
	const heightInMapUnits = reader.readUe() + 1
	const frameMbsOnly = reader.readBit()
	if (!frameMbsOnly) reader.readBit() // mb_adaptive_frame_field_flag
	reader.readBit() // direct_8x8_inference_flag

	let cropLeft = 0
	let cropRight = 0
	let cropTop = 0
	let cropBottom = 0
	if (reader.readBit()) {
		// frame_cropping_flag
		cropLeft = reader.readUe()
		cropRight = reader.readUe()
		cropTop = reader.readUe()
		cropBottom = reader.readUe()
	}

	// Crop offsets are expressed in chroma sample units, so the multiplier
	// depends on the chroma format — and vertically also on interlacing.
	const subWidth = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1
	const subHeight = chromaFormatIdc === 1 ? 2 : 1
	const cropUnitX = subWidth
	const cropUnitY = subHeight * (2 - frameMbsOnly)

	const width = widthInMbs * 16 - cropUnitX * (cropLeft + cropRight)
	// A field-coded stream stores half-height map units, hence the doubling.
	const height = (2 - frameMbsOnly) * heightInMapUnits * 16 - cropUnitY * (cropTop + cropBottom)

	return { profileIdc, levelIdc, width: Math.max(0, width), height: Math.max(0, height), chromaFormatIdc }
}

/**
 * Split an Annex B byte stream into NAL units.
 *
 * Start codes are `00 00 01` optionally preceded by extra `00` bytes. Trailing
 * zeros are trimmed from each unit: they are either part of the following start
 * code or `cabac_zero_words`, both of which are discardable.
 *
 * @param {Uint8Array} bytes
 * @returns {Generator<Uint8Array>}
 */
export function* nalUnits(bytes) {
	const length = bytes.byteLength
	let index = 0
	let start = -1

	while (index + 2 < length) {
		if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
			if (start >= 0 && index > start) {
				const unit = trimTrailingZeros(bytes.subarray(start, index))
				if (unit.byteLength) yield unit
			}
			index += 3
			start = index
		} else {
			index++
		}
	}

	if (start >= 0 && start < length) {
		const unit = trimTrailingZeros(bytes.subarray(start, length))
		if (unit.byteLength) yield unit
	}
}

/** @param {Uint8Array} bytes */
function trimTrailingZeros(bytes) {
	let end = bytes.byteLength
	while (end > 0 && bytes[end - 1] === 0) end--
	return bytes.subarray(0, end)
}

/**
 * Walk ADTS frames. Works on a TS PES payload and on a bare `.aac` segment
 * alike, which matters because audio-only HLS renditions serve both.
 *
 * @param {Uint8Array} bytes
 * @returns {Generator<{ data: Uint8Array, audioObjectType: number, samplingFrequencyIndex: number, channelCount: number, end: number }>}
 */
export function* adtsFrames(bytes) {
	const length = bytes.byteLength
	let index = 0

	while (index + 7 <= length) {
		// Syncword is 12 bits of 1, then a 1-bit MPEG id and a 2-bit layer field
		// that must be zero for AAC. Masking 0xf6 tests sync + layer at once.
		if (bytes[index] !== 0xff || (bytes[index + 1] & 0xf6) !== 0xf0) {
			index++
			continue
		}

		const protectionAbsent = bytes[index + 1] & 0x01
		const headerLength = protectionAbsent ? 7 : 9
		const frameLength = ((bytes[index + 3] & 0x03) << 11) | (bytes[index + 4] << 3) | ((bytes[index + 5] & 0xe0) >> 5)

		if (frameLength < headerLength || index + frameLength > length) return

		yield {
			data: bytes.subarray(index + headerLength, index + frameLength),
			// The 2-bit ADTS profile field is audioObjectType minus one.
			audioObjectType: ((bytes[index + 2] & 0xc0) >> 6) + 1,
			samplingFrequencyIndex: (bytes[index + 2] & 0x3c) >> 2,
			channelCount: ((bytes[index + 2] & 0x01) << 2) | ((bytes[index + 3] & 0xc0) >> 6),
			end: index + frameLength,
		}

		index += frameLength
	}
}

/* ================================================================== *
 * Timestamps
 * ================================================================== */

const PTS_MODULUS = 8589934592 // 2^33
const PTS_HALF = 4294967296 // 2^32

/**
 * Read a 33-bit PTS/DTS from a 5-byte PES field.
 *
 * The value is interleaved with marker bits, and crucially it does not fit in
 * a 32-bit signed integer — so `<<` cannot be used anywhere here. JavaScript
 * bitwise operators coerce to int32 and would silently truncate the top bits.
 *
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function readTimestamp(bytes, offset) {
	return (
		(bytes[offset] & 0x0e) * 536870912 + // bits 32..30, << 29
		bytes[offset + 1] * 4194304 + // << 22
		(bytes[offset + 2] & 0xfe) * 16384 + // << 14
		bytes[offset + 3] * 128 + // << 7
		(bytes[offset + 4] & 0xfe) / 2 // >> 1
	)
}

/**
 * Convert wrapping 33-bit timestamps into a monotonically increasing timeline.
 *
 * The PES clock wraps roughly every 26.5 hours, and stitched ad breaks can jump
 * discontinuously. Without unwrapping, one wrap turns every subsequent sample
 * duration negative and the output file's timeline collapses.
 */
class TimestampUnwrapper {
	constructor() {
		this.offset = 0
		this.lastRaw = null
	}

	/** @param {number} raw */
	unwrap(raw) {
		if (this.lastRaw !== null) {
			if (raw + PTS_HALF < this.lastRaw) {
				this.offset += PTS_MODULUS // wrapped forward
			} else if (raw > this.lastRaw + PTS_HALF) {
				this.offset -= PTS_MODULUS // wrapped backward
			}
		}
		this.lastRaw = raw
		return raw + this.offset
	}

	reset() {
		this.offset = 0
		this.lastRaw = null
	}
}

/* ================================================================== *
 * Transport stream demuxer
 * ================================================================== */

/**
 * Demux a transport stream into PES packets for one video and one audio
 * elementary stream.
 */
export class TsDemuxer {
	constructor() {
		this.pmtPid = -1
		this.videoPid = -1
		this.audioPid = -1
		this.videoStreamType = 0
		this.audioStreamType = 0

		/** @type {Map<number, Array<Uint8Array>>} */
		this.assembling = new Map()
		/** @type {Array<{ data: Uint8Array, pts: number, dts: number }>} */
		this.videoPes = []
		/** @type {Array<{ data: Uint8Array, pts: number, dts: number }>} */
		this.audioPes = []

		/** @type {Set<string>} */
		this.warnings = new Set()
		/** @type {string|null} */
		this.fatal = null
		this.scrambled = false

		/** Bytes carried over when a push ends mid-packet. */
		this.tail = new Uint8Array(0)
	}

	/**
	 * Find a packet boundary, verified one packet ahead so a stray 0x47 inside
	 * payload data does not derail the loop.
	 * @param {Uint8Array} data
	 * @param {number} from
	 */
	#findSync(data, from) {
		for (let index = from; index + TS_PACKET_SIZE < data.byteLength; index++) {
			if (data[index] === 0x47 && data[index + TS_PACKET_SIZE] === 0x47) return index
		}
		// Near the end of the buffer, accept a bare sync byte.
		for (let index = from; index < data.byteLength; index++) {
			if (data[index] === 0x47) return index
		}
		return -1
	}

	/** @param {Uint8Array} chunk */
	push(chunk) {
		const data = this.tail.byteLength ? concat([this.tail, chunk]) : chunk
		let offset = data[0] === 0x47 ? 0 : this.#findSync(data, 0)

		if (offset < 0) {
			this.tail = data.byteLength > TS_PACKET_SIZE * 2 ? new Uint8Array(0) : data
			return
		}

		while (offset + TS_PACKET_SIZE <= data.byteLength) {
			if (data[offset] !== 0x47) {
				const next = this.#findSync(data, offset + 1)
				this.warnings.add("Lost transport stream sync; resynchronised")
				if (next < 0) break
				offset = next
				continue
			}
			this.#handlePacket(data.subarray(offset, offset + TS_PACKET_SIZE))
			offset += TS_PACKET_SIZE
		}

		this.tail = data.subarray(offset)
	}

	/** @param {Uint8Array} packet */
	#handlePacket(packet) {
		const payloadUnitStart = (packet[1] & 0x40) !== 0
		const pid = ((packet[1] & 0x1f) << 8) | packet[2]

		// A non-zero transport_scrambling_control means the payload is encrypted at
		// the transport layer. Nothing downstream can read it.
		if ((packet[3] & 0xc0) !== 0) {
			if (!this.scrambled) {
				this.scrambled = true
				this.fatal = "Transport stream payload is scrambled"
			}
			return
		}

		const adaptationControl = (packet[3] & 0x30) >> 4
		if (adaptationControl === 0 || adaptationControl === 2) return // no payload

		let offset = 4
		if (adaptationControl === 3) {
			offset = 5 + packet[4]
			if (offset >= TS_PACKET_SIZE) return
		}
		const payload = packet.subarray(offset)

		if (pid === 0) {
			this.#parsePat(payload, payloadUnitStart)
		} else if (pid === this.pmtPid) {
			this.#parsePmt(payload, payloadUnitStart)
		} else if (pid === this.videoPid) {
			this.#collect(pid, payload, payloadUnitStart, this.videoPes)
		} else if (pid === this.audioPid) {
			this.#collect(pid, payload, payloadUnitStart, this.audioPes)
		}
	}

	/**
	 * Program Association Table — gives us the PMT's PID.
	 * @param {Uint8Array} payload
	 * @param {boolean} payloadUnitStart
	 */
	#parsePat(payload, payloadUnitStart) {
		// When a section starts in this packet, the first byte is a pointer_field
		// counting filler bytes before the section itself.
		let cursor = payloadUnitStart ? payload[0] + 1 : 0
		if (cursor + 8 > payload.byteLength || payload[cursor] !== 0x00) return

		const sectionLength = ((payload[cursor + 1] & 0x0f) << 8) | payload[cursor + 2]
		const end = Math.min(cursor + 3 + sectionLength - 4, payload.byteLength) // -4 drops the CRC

		// table_id(1) + section_length(2) + transport_stream_id(2) + version(1)
		// + section_number(1) + last_section_number(1) = 8
		let entry = cursor + 8
		while (entry + 4 <= end) {
			const programNumber = (payload[entry] << 8) | payload[entry + 1]
			const pid = ((payload[entry + 2] & 0x1f) << 8) | payload[entry + 3]
			// program_number 0 is the network information table, not a program.
			if (programNumber !== 0) {
				this.pmtPid = pid
				return
			}
			entry += 4
		}
	}

	/**
	 * Program Map Table — gives us the elementary stream PIDs and their codecs.
	 * @param {Uint8Array} payload
	 * @param {boolean} payloadUnitStart
	 */
	#parsePmt(payload, payloadUnitStart) {
		let cursor = payloadUnitStart ? payload[0] + 1 : 0
		if (cursor + 12 > payload.byteLength || payload[cursor] !== 0x02) return

		const sectionLength = ((payload[cursor + 1] & 0x0f) << 8) | payload[cursor + 2]
		const end = Math.min(cursor + 3 + sectionLength - 4, payload.byteLength)
		const programInfoLength = ((payload[cursor + 10] & 0x0f) << 8) | payload[cursor + 11]

		let entry = cursor + 12 + programInfoLength
		while (entry + 5 <= end) {
			const streamType = payload[entry]
			const pid = ((payload[entry + 1] & 0x1f) << 8) | payload[entry + 2]
			const esInfoLength = ((payload[entry + 3] & 0x0f) << 8) | payload[entry + 4]

			const info = STREAM_TYPES[streamType]

			if (info?.supported && info.kind === "video" && this.videoPid === -1) {
				this.videoPid = pid
				this.videoStreamType = streamType
			} else if (info?.supported && info.kind === "audio" && this.audioPid === -1) {
				this.audioPid = pid
				this.audioStreamType = streamType
			} else if (info && !info.supported && !info.ignorable) {
				// A codec we can name but cannot write. Fatal, so the engine falls
				// back to ffmpeg rather than dropping the track silently.
				this.fatal = `Unsupported stream: ${info.name}`
			} else if (!info) {
				this.warnings.add(`Unknown stream_type 0x${streamType.toString(16).padStart(2, "0")}; ignored`)
			}

			entry += 5 + esInfoLength
		}
	}

	/**
	 * Accumulate a PES packet across transport packets. Each new
	 * payload_unit_start closes the previous one.
	 * @param {number} pid
	 * @param {Uint8Array} payload
	 * @param {boolean} payloadUnitStart
	 * @param {Array<Object>} sink
	 */
	#collect(pid, payload, payloadUnitStart, sink) {
		if (payloadUnitStart) {
			this.#closePes(pid, sink)
			this.assembling.set(pid, [payload])
		} else {
			const chunks = this.assembling.get(pid)
			if (chunks) chunks.push(payload)
		}
	}

	/**
	 * @param {number} pid
	 * @param {Array<Object>} sink
	 */
	#closePes(pid, sink) {
		const chunks = this.assembling.get(pid)
		if (!chunks?.length) return
		this.assembling.delete(pid)

		const parsed = parsePesPacket(concat(chunks))
		if (parsed) sink.push(parsed)
	}

	/** Close any PES packet still being assembled. Call at end of stream. */
	finish() {
		if (this.videoPid !== -1) this.#closePes(this.videoPid, this.videoPes)
		if (this.audioPid !== -1) this.#closePes(this.audioPid, this.audioPes)
	}

	/** Take everything demuxed so far and clear the buffers. */
	drain() {
		const video = this.videoPes
		const audio = this.audioPes
		this.videoPes = []
		this.audioPes = []
		return { video, audio }
	}

	/** Forget stream layout, e.g. across an EXT-X-DISCONTINUITY. */
	reset() {
		this.assembling.clear()
		this.tail = new Uint8Array(0)
	}
}

/**
 * Parse a PES packet header and return its payload with timestamps.
 * @param {Uint8Array} bytes
 * @returns {{ data: Uint8Array, pts: number, dts: number }|null}
 */
export function parsePesPacket(bytes) {
	if (bytes.byteLength < 9) return null
	// packet_start_code_prefix
	if (bytes[0] !== 0x00 || bytes[1] !== 0x00 || bytes[2] !== 0x01) return null

	const ptsDtsFlags = (bytes[7] & 0xc0) >> 6
	const headerDataLength = bytes[8]
	const payloadStart = 9 + headerDataLength
	if (payloadStart > bytes.byteLength) return null

	let pts = null
	let dts = null
	let cursor = 9
	if (ptsDtsFlags & 0x02) {
		if (cursor + 5 > bytes.byteLength) return null
		pts = readTimestamp(bytes, cursor)
		cursor += 5
	}
	if (ptsDtsFlags & 0x01) {
		if (cursor + 5 > bytes.byteLength) return null
		dts = readTimestamp(bytes, cursor)
	}

	const data = bytes.subarray(payloadStart)
	if (!data.byteLength) return null

	// A stream with no B-frames may omit DTS entirely; it then equals PTS.
	return { data, pts: pts ?? dts ?? 0, dts: dts ?? pts ?? 0 }
}

/* ================================================================== *
 * Transmuxer
 * ================================================================== */

const VIDEO_TRACK_ID = 1
const AUDIO_TRACK_ID = 2
const VIDEO_TIMESCALE = 90000 // the MPEG-TS system clock
const AAC_SAMPLES_PER_FRAME = 1024
/** ~29.97 fps in 90 kHz ticks. Used only for the very last sample. */
const DEFAULT_VIDEO_DURATION = 3003

/**
 * Turn a sequence of MPEG-TS (or bare ADTS) segments into fragmented MP4.
 *
 * Usage:
 *   const muxer = new Transmuxer()
 *   for (const segment of segments) { muxer.push(segment); out.push(muxer.flush()) }
 *   out.push(muxer.end())
 *
 * `flush()` returns the initialisation segment exactly once, on the first call
 * that has seen enough of the stream to describe it.
 */
export class Transmuxer {
	constructor() {
		this.demuxer = new TsDemuxer()

		/** @type {Array<Uint8Array>} */
		this.sps = []
		/** @type {Array<Uint8Array>} */
		this.pps = []
		this.spsInfo = null
		this.audioParams = null

		/** @type {Array<Object>} */
		this.videoQueue = []
		/** Held back until the next sample's DTS reveals this one's duration. */
		this.videoPending = null
		/** @type {Array<Object>} */
		this.audioQueue = []

		this.videoUnwrap = new TimestampUnwrapper()
		this.audioUnwrap = new TimestampUnwrapper()

		/**
		 * Shared origin for both tracks. Normalising each track against its own
		 * first timestamp would shift them apart by their start delta and put the
		 * file permanently out of sync.
		 */
		this.baseTime90k = null
		this.nextAudioDts = null

		this.sequenceNumber = 1
		this.initSent = false
		this.lastVideoDuration = DEFAULT_VIDEO_DURATION

		/** @type {Set<string>} */
		this.warnings = new Set()
		/** @type {string|null} */
		this.fatal = null
	}

	/**
	 * Feed one segment. Container is sniffed rather than inferred from the URL,
	 * because CDNs serve TS from `.m4s` paths and vice versa often enough to
	 * matter.
	 * @param {Uint8Array} bytes
	 */
	push(bytes) {
		const data = skipId3(bytes)
		if (!data.byteLength) return

		switch (sniffContainer(data)) {
			case "ts":
				this.demuxer.push(data)
				break
			case "adts":
				this.#ingestAdts(data, null)
				break
			case "mp4":
				this.fatal = "fMP4 segment routed to the TS transmuxer"
				break
			case "webm":
				this.fatal = "WebM/Matroska segments cannot be remuxed in-browser"
				break
			default:
				// Possibly a transport stream that lost its leading sync byte. Try,
				// but record it — if nothing demuxes, flush() reports empty output.
				this.warnings.add("Segment header not recognised; attempted as transport stream")
				this.demuxer.push(data)
		}
	}

	/** @param {{ data: Uint8Array, pts: number, dts: number }} pes */
	#ingestVideoPes(pes) {
		const dts = this.videoUnwrap.unwrap(pes.dts)
		const pts = dts + (pes.pts - pes.dts)

		const parts = []
		let isSync = false
		let length = 0

		for (const nal of nalUnits(pes.data)) {
			const nalType = nal[0] & 0x1f

			if (nalType === 7) {
				if (!this.sps.length) {
					this.sps = [nal]
					try {
						this.spsInfo = parseSps(nal)
					} catch {
						this.warnings.add("Could not parse SPS; falling back to 0x0 dimensions")
					}
				}
			} else if (nalType === 8) {
				if (!this.pps.length) this.pps = [nal]
			} else if (nalType === 9 || nalType === 12) {
				// Access unit delimiter and filler data carry nothing an MP4 needs.
				continue
			}

			if (nalType === 5) isSync = true

			// avcC declares 4-byte NAL lengths, so convert from start-code
			// delimited Annex B to length-prefixed AVCC.
			const prefix = new Uint8Array(4)
			new DataView(prefix.buffer).setUint32(0, nal.byteLength)
			parts.push(prefix, nal)
			length += 4 + nal.byteLength
		}

		if (!length) return
		if (this.baseTime90k === null) this.baseTime90k = dts

		const sample = {
			data: concat(parts),
			dts,
			cts: Math.max(0, pts - dts),
			isSync,
			duration: 0,
		}

		// Duration is the gap to the *next* sample, so the previous one can only
		// be finalised now.
		if (this.videoPending) {
			const gap = sample.dts - this.videoPending.dts
			this.videoPending.duration = gap > 0 ? gap : this.lastVideoDuration
			this.lastVideoDuration = this.videoPending.duration
			this.videoQueue.push(this.videoPending)
		}
		this.videoPending = sample
	}

	/**
	 * @param {Uint8Array} bytes ADTS data
	 * @param {number|null} pts90k presentation time from the PES header, if any
	 */
	#ingestAdts(bytes, pts90k) {
		let frames = 0
		let dts = this.nextAudioDts

		for (const frame of adtsFrames(bytes)) {
			if (!this.audioParams) {
				const sampleRate = ADTS_SAMPLE_RATES[frame.samplingFrequencyIndex]
				if (!sampleRate) {
					this.fatal = `Reserved AAC sampling frequency index ${frame.samplingFrequencyIndex}`
					return
				}
				if (frame.audioObjectType !== 2) {
					// HE-AAC (5) and HE-AACv2 (29) need an explicit hierarchy in the
					// AudioSpecificConfig that this writer does not emit.
					this.fatal = `Unsupported AAC audio object type ${frame.audioObjectType}`
					return
				}
				this.audioParams = {
					sampleRate,
					channelCount: frame.channelCount || 2,
					audioObjectType: frame.audioObjectType,
					samplingFrequencyIndex: frame.samplingFrequencyIndex,
				}
			}

			const { sampleRate } = this.audioParams

			if (dts === null) {
				// First ever frame: anchor to the PES clock if we have one.
				if (pts90k !== null) {
					if (this.baseTime90k === null) this.baseTime90k = pts90k
					dts = Math.round((pts90k * sampleRate) / VIDEO_TIMESCALE)
				} else {
					dts = 0
					if (this.baseTime90k === null) this.baseTime90k = 0
				}
			} else if (frames === 0 && pts90k !== null) {
				// Only the first frame of a PES carries a timestamp; the rest advance
				// by a frame each. Resync when the declared time drifts far enough
				// that trusting the counter would desynchronise audio.
				const declared = Math.round((pts90k * sampleRate) / VIDEO_TIMESCALE)
				if (Math.abs(declared - dts) > AAC_SAMPLES_PER_FRAME * 3) dts = declared
			}

			this.audioQueue.push({
				data: frame.data,
				dts,
				cts: 0,
				isSync: true, // every AAC frame is independently decodable
				duration: AAC_SAMPLES_PER_FRAME,
			})

			dts += AAC_SAMPLES_PER_FRAME
			frames++
		}

		if (frames) this.nextAudioDts = dts
	}

	/** Track descriptions for buildInitSegment, or null if not yet knowable. */
	#describeTracks() {
		const tracks = []

		if (this.sps.length && this.pps.length) {
			tracks.push({
				id: VIDEO_TRACK_ID,
				kind: "video",
				timescale: VIDEO_TIMESCALE,
				width: this.spsInfo?.width || 0,
				height: this.spsInfo?.height || 0,
				sps: this.sps,
				pps: this.pps,
			})
		}

		if (this.audioParams) {
			tracks.push({
				id: AUDIO_TRACK_ID,
				kind: "audio",
				timescale: this.audioParams.sampleRate,
				channelCount: this.audioParams.channelCount,
				sampleRate: this.audioParams.sampleRate,
				audioObjectType: this.audioParams.audioObjectType,
				samplingFrequencyIndex: this.audioParams.samplingFrequencyIndex,
			})
		}

		return tracks
	}

	/**
	 * Emit everything currently decodable.
	 * @param {{ final?: boolean }} [options]
	 * @returns {{ initSegment: Uint8Array|null, data: Uint8Array, warnings: Array<string>, fatal: string|null }}
	 */
	flush({ final = false } = {}) {
		if (final) this.demuxer.finish()

		const { video, audio } = this.demuxer.drain()
		for (const pes of video) this.#ingestVideoPes(pes)
		for (const pes of audio) {
			const pts = this.audioUnwrap.unwrap(pes.pts)
			this.#ingestAdts(pes.data, pts)
		}

		if (final && this.videoPending) {
			this.videoPending.duration = this.lastVideoDuration
			this.videoQueue.push(this.videoPending)
			this.videoPending = null
		}

		const fatal = this.fatal || this.demuxer.fatal
		for (const warning of this.demuxer.warnings) this.warnings.add(warning)

		if (fatal) {
			return { initSegment: null, data: new Uint8Array(0), warnings: [...this.warnings], fatal }
		}

		const videoSamples = this.videoQueue
		const audioSamples = this.audioQueue
		this.videoQueue = []
		this.audioQueue = []

		if (!videoSamples.length && !audioSamples.length) {
			return { initSegment: null, data: new Uint8Array(0), warnings: [...this.warnings], fatal: null }
		}

		let initSegment = null
		if (!this.initSent) {
			const tracks = this.#describeTracks()
			if (!tracks.length) {
				return {
					initSegment: null,
					data: new Uint8Array(0),
					warnings: [...this.warnings],
					fatal: "No decodable track found in the transport stream",
				}
			}
			initSegment = buildInitSegment(tracks)
			this.initSent = true
		}

		const base = this.baseTime90k ?? 0
		const fragmentTracks = []

		if (videoSamples.length) {
			fragmentTracks.push({
				id: VIDEO_TRACK_ID,
				baseMediaDecodeTime: Math.max(0, videoSamples[0].dts - base),
				samples: videoSamples,
			})
		}

		if (audioSamples.length && this.audioParams) {
			// Convert the shared 90 kHz origin into this track's own timescale.
			const audioBase = Math.round((base * this.audioParams.sampleRate) / VIDEO_TIMESCALE)
			fragmentTracks.push({
				id: AUDIO_TRACK_ID,
				baseMediaDecodeTime: Math.max(0, audioSamples[0].dts - audioBase),
				samples: audioSamples,
			})
		}

		const data = fragmentTracks.length
			? buildMediaSegment({ sequenceNumber: this.sequenceNumber++, tracks: fragmentTracks })
			: new Uint8Array(0)

		return { initSegment, data, warnings: [...this.warnings], fatal: null }
	}

	/** Final flush: closes the pending PES and emits the held-back sample. */
	end() {
		return this.flush({ final: true })
	}

	/** What this transmuxer determined about the stream. For logging and UI. */
	describe() {
		return {
			video: this.sps.length
				? {
						codec: "avc1",
						width: this.spsInfo?.width || 0,
						height: this.spsInfo?.height || 0,
						profileIdc: this.spsInfo?.profileIdc,
						levelIdc: this.spsInfo?.levelIdc,
				  }
				: null,
			audio: this.audioParams
				? {
						codec: "mp4a.40.2",
						sampleRate: this.audioParams.sampleRate,
						channelCount: this.audioParams.channelCount,
				  }
				: null,
			warnings: [...this.warnings],
			fatal: this.fatal || this.demuxer.fatal,
		}
	}
}
