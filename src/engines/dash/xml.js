/**
 * Minimal, dependency-free XML reader.
 *
 * `DOMParser` does not exist in a Manifest V3 service worker, and routing every
 * MPD through the offscreen document just to parse a few kilobytes of XML is a
 * poor trade. This tokeniser is deliberately small: it understands elements,
 * attributes, self-closing tags, text, comments, CDATA, processing instructions
 * and doctypes, which is the entire surface an MPD needs. Namespace prefixes are
 * stripped, since DASH manifests in the wild are inconsistent about them.
 *
 * @module engines/dash/xml
 */

/**
 * @typedef {Object} XmlNode
 * @property {string} name local name, namespace prefix removed
 * @property {Record<string,string>} attrs
 * @property {XmlNode[]} children
 * @property {string} text concatenated direct text content
 */

const ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
}

/** @param {string} s */
function decodeEntities(s) {
	if (!s.includes("&")) return s
	return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
			return Number.isFinite(code) ? String.fromCodePoint(code) : match
		}
		const key = body.toLowerCase()
		return key in ENTITIES ? ENTITIES[key] : match
	})
}

/** @param {string} name */
function localName(name) {
	const i = name.indexOf(":")
	return i === -1 ? name : name.slice(i + 1)
}

/**
 * @param {string} source
 * @returns {Record<string,string>}
 */
function readAttributes(source) {
	/** @type {Record<string,string>} */
	const attrs = {}
	const re = /([\w:.\-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
	let m
	while ((m = re.exec(source)) !== null) {
		attrs[localName(m[1])] = decodeEntities(m[3] ?? m[4] ?? "")
	}
	return attrs
}

/**
 * Parse an XML document into a tree.
 * @param {string} xml
 * @returns {XmlNode}
 * @throws {Error} when no root element can be found
 */
export function parseXml(xml) {
	/** @type {XmlNode} */
	const root = { name: "#document", attrs: {}, children: [], text: "" }
	const stack = [root]
	let i = 0

	while (i < xml.length) {
		const lt = xml.indexOf("<", i)
		if (lt === -1) break

		if (lt > i) {
			const chunk = xml.slice(i, lt)
			if (chunk.trim()) stack[stack.length - 1].text += decodeEntities(chunk)
		}

		if (xml.startsWith("<!--", lt)) {
			const end = xml.indexOf("-->", lt)
			i = end === -1 ? xml.length : end + 3
			continue
		}
		if (xml.startsWith("<![CDATA[", lt)) {
			const end = xml.indexOf("]]>", lt)
			const body = xml.slice(lt + 9, end === -1 ? xml.length : end)
			stack[stack.length - 1].text += body
			i = end === -1 ? xml.length : end + 3
			continue
		}
		if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
			const end = xml.indexOf(">", lt)
			i = end === -1 ? xml.length : end + 1
			continue
		}

		const gt = xml.indexOf(">", lt)
		if (gt === -1) break
		const raw = xml.slice(lt + 1, gt).trim()

		if (raw.startsWith("/")) {
			if (stack.length > 1) stack.pop()
			i = gt + 1
			continue
		}

		const selfClosing = raw.endsWith("/")
		const body = selfClosing ? raw.slice(0, -1) : raw
		const spaceAt = body.search(/\s/)
		const name = localName(spaceAt === -1 ? body : body.slice(0, spaceAt))
		const attrs = spaceAt === -1 ? {} : readAttributes(body.slice(spaceAt))

		/** @type {XmlNode} */
		const node = { name, attrs, children: [], text: "" }
		stack[stack.length - 1].children.push(node)
		if (!selfClosing) stack.push(node)
		i = gt + 1
	}

	const rootEl = root.children[0]
	if (!rootEl) throw new Error("XML document has no root element")
	return rootEl
}

/** @param {XmlNode} node @param {string} name */
export function childrenNamed(node, name) {
	return node.children.filter((c) => c.name === name)
}

/** @param {XmlNode} node @param {string} name */
export function firstNamed(node, name) {
	return node.children.find((c) => c.name === name) ?? null
}
