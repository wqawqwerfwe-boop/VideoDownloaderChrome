#!/usr/bin/env bash
#
# Register the OpenVideo Downloader companion host on macOS or Linux.
#
#   bash install.sh <EXTENSION_ID>
#   bash install.sh --uninstall
#
# The extension ID is required because an unpacked extension is given a new
# random ID whenever it is loaded from a different directory, so a manifest
# with a fixed allowed_origins would only ever work on one machine. Find the
# ID on chrome://extensions with Developer mode turned on.
#
# This script only locates a usable interpreter and hands over to
# host.py --install, which writes the manifest and sets the executable bit.
# Keeping the JSON generation in one language avoids maintaining two sets of
# quoting rules for the same file.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="${SCRIPT_DIR}/host.py"

if [ ! -f "${HOST_SCRIPT}" ]; then
  echo "error: host.py was not found next to this script (${SCRIPT_DIR})" >&2
  exit 1
fi

# Do not rely on host.py's shebang: /usr/bin/python3 is missing on some minimal
# systems, and on macOS the Homebrew interpreter is not always first on PATH.
PYTHON=""
for candidate in python3 python3.13 python3.12 python3.11 python3.10 python3.9 python; do
  if command -v "${candidate}" >/dev/null 2>&1; then
    if "${candidate}" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 7) else 1)' >/dev/null 2>&1; then
      PYTHON="$(command -v "${candidate}")"
      break
    fi
  fi
done

if [ -z "${PYTHON}" ]; then
  echo "error: no Python 3.7+ interpreter found." >&2
  case "$(uname -s)" in
    Darwin) echo "  try: brew install python" >&2 ;;
    *)      echo "  try: sudo apt install python3   (or your distro's equivalent)" >&2 ;;
  esac
  exit 1
fi

echo "Using interpreter: ${PYTHON}"

if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "-u" ]; then
  exec "${PYTHON}" "${HOST_SCRIPT}" --uninstall
fi

if [ "$#" -eq 0 ]; then
  cat >&2 <<'USAGE'
error: no extension ID given.

  bash install.sh <EXTENSION_ID>

To find the ID:
  1. open chrome://extensions
  2. enable "Developer mode" (top right)
  3. copy the 32-letter ID shown under "OpenVideo Downloader"

Reload the extension from a new folder and the ID changes, so re-run this
script if downloads suddenly report the host as missing.
USAGE
  exit 2
fi

exec "${PYTHON}" "${HOST_SCRIPT}" --install "$@"
