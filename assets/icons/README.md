# Extension icons

This directory is intentionally empty of PNGs in git, and `manifest.json`
intentionally has **no `icons` key**.

## Why not just point the manifest at the paths?

Because Chrome resolves manifest icon paths *at load time* and treats a missing
file as a fatal error:

```
Could not load icon 'assets/icons/icon48.png' specified in 'icons'.
Could not load manifest.
```

A "stub" entry pointing at a file that does not exist would mean the extension
cannot be loaded unpacked at all — which is the one thing the project must not
give up. Chrome falls back to a generic action icon when the key is absent, so
omitting it costs nothing but a placeholder puzzle piece in the toolbar.

Binary files also cannot be committed through the text-only path used to author
this repository, so shipping real PNGs here was not an option either. Generating
them locally is a five-second job instead.

## Generating them

Open [`tools/make-icons.html`](../../tools/make-icons.html) in Chrome and click
**Generate**. It renders the mark on a `<canvas>` at each required size and
saves four files to your Downloads folder:

```
icon16.png  icon32.png  icon48.png  icon128.png
```

Move them into this directory:

```sh
mv ~/Downloads/icon{16,32,48,128}.png assets/icons/
```

Then add this block to `manifest.json` (top level) and reload the extension:

```json
"icons": {
	"16": "assets/icons/icon16.png",
	"32": "assets/icons/icon32.png",
	"48": "assets/icons/icon48.png",
	"128": "assets/icons/icon128.png"
}
```

To use the same artwork for the toolbar button, add `default_icon` inside the
existing `action` object:

```json
"action": {
	"default_popup": "src/popup/popup.html",
	"default_title": "OpenVideo Downloader",
	"default_icon": {
		"16": "assets/icons/icon16.png",
		"32": "assets/icons/icon32.png",
		"48": "assets/icons/icon48.png",
		"128": "assets/icons/icon128.png"
	}
}
```

Any 16/32/48/128 PNG set works — replace the generated ones with real artwork
whenever you have it.
