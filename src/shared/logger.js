/**
 * Tiny level-aware logger. Kept dependency-free so it can be imported from the
 * service worker, offscreen document and workers alike.
 * @module shared/logger
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

let current = LEVELS.info

/** @param {keyof LEVELS} level */
export function setLogLevel(level) {
	if (level in LEVELS) current = LEVELS[level]
}

function emit(level, method, scope, args) {
	if (current < LEVELS[level]) return
	// eslint-disable-next-line no-console
	console[method](`%c[ovd:${scope}]`, "color:#34d399", ...args)
}

/**
 * @param {string} scope
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
export function createLogger(scope) {
	return {
		debug: (...a) => emit("debug", "debug", scope, a),
		info: (...a) => emit("info", "log", scope, a),
		warn: (...a) => emit("warn", "warn", scope, a),
		error: (...a) => emit("error", "error", scope, a),
	}
}
