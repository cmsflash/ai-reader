# AI Reader

Minimal web MVP for saving URLs and documents as server-stored readable articles, syncing reading progress, and supporting TTS playback.

## Import options

- Save a URL or upload a supported document directly.
- Pull saved articles from an Instapaper folder through the official Full API.
- Pull @Voice Reader documents from `/Apps/@Voice` in Dropbox.
- Save the active Chrome page from the included Manifest V3 extension and keyboard shortcut.
- Share a URL to the installed Android PWA.
- Share a URL from iPhone or iPad with an Apple Shortcut that opens `/share?url=...`.

Provider imports are idempotent: another sync imports new or changed source items without duplicating
completed items.

## Run

```bash
npm install
npm run dev
```

Local article data, archived artifacts, and secrets are intentionally ignored.

For provider credentials, Chrome extension packaging, Android installation, and the iOS Shortcut,
see [Production Setup](docs/production.md).

## Chrome extension

The unpacked extension lives in [`integrations/chrome-extension`](integrations/chrome-extension).
After configuring the personal import token, use the toolbar action or `Command+Shift+Y` on macOS
(`Ctrl+Shift+Y` elsewhere). Chrome may require assigning the shortcut manually at
`chrome://extensions/shortcuts`.

For local development, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select that directory. A production deployment can serve the packaged download at
`/ai-reader-chrome-extension.zip`; Chrome still requires unzipping it before **Load unpacked**.
See Chrome's guides to [load an unpacked
extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
and [manage extension keyboard
commands](https://developer.chrome.com/docs/extensions/reference/api/commands).

## Mobile sharing

On Android, sign in to the deployed reader in Chrome and install it as a PWA. The installed app
then appears as **AI Reader** in Android's share target picker. This relies on the standard
[Web Share Target API](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target).

On iPhone or iPad, create a Share Sheet Shortcut that accepts URLs or Safari web pages,
percent-encodes the input, and opens:

```text
https://YOUR_AI_READER_ORIGIN/share?url=ENCODED_SHORTCUT_INPUT&source=ios-shortcut
```

Enable **Show in Share Sheet** in the Shortcut details. Keep Safari signed into the same AI Reader
origin. Apple documents [Share Sheet
Shortcuts](https://support.apple.com/guide/shortcuts/launch-a-shortcut-from-another-app-apd163eb9f95/ios)
and [Shortcut input
types](https://support.apple.com/guide/shortcuts/understanding-input-types-apd7644168e1/ios).

## License

MIT
