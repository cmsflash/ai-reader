# AI Reader

Personal reader for saving URLs and documents, syncing reading progress, listening with TTS, and
discussing whole articles or selected passages with AI.

## Import options

- Save a URL or upload a supported document directly.
- Pull saved articles from an Instapaper folder through the official Full API.
- Pull @Voice Reader documents from `/Apps/@Voice` in Dropbox.
- Save the active Chrome page from the included Manifest V3 extension and keyboard shortcut.
- Share a URL to the installed Android PWA.
- Share a URL from iPhone or iPad with an Apple Shortcut that opens `/share?url=...`.

Provider imports are idempotent and content-aware: another sync imports new or changed source items,
deduplicates substantially identical material across providers and the existing library, and retains
each provider's provenance.

## Audio playback

Choose **Online voice** or **Local voice (offline)** in the reader. Online Play
requests OpenAI narration only for that article, saves the result, and reuses it
on later plays. Sentence timing may be approximate when transcription alignment
is uncertain; substantial content mismatches still fail. Imports, folder changes, and library visits do not generate audio.
English uses `tts-1`; Mandarin uses the existing `gpt-4o-mini-tts` profile.

Local voice uses an installed device voice with no TTS API charge. It works for
an already-open article without a network connection; the app does not download
or cache the library for offline access. If no matching installed voice exists,
the reader asks you to download one in device settings. Online mode has an
optional local fallback. Source and fallback choices persist on this device.

## AI discussion

- Choose **Discuss** to chat about the entire open article.
- Select article text to discuss only that passage.
- Typed chat uses `gpt-5.6-sol` with medium reasoning.
- Pure voice uses a server-initiated WebRTC session with `gpt-realtime-2`.

The browser never receives the OpenAI API key. Selected-passage requests are checked against the
authorized saved article on the server and do not include surrounding article text.

## Run

```bash
npm install
npm run dev
```

Local article data, archived artifacts, and secrets are intentionally ignored.

For OpenAI and provider credentials, Chrome extension packaging, Android installation, and the iOS
Shortcut, see [Production Setup](docs/production.md).

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
Chrome must launch or focus a PWA share target, so a web app cannot receive the share invisibly in
the source app. AI Reader keeps that handoff short: once the server has queued extraction, it asks
Chrome to close the share-launched window and return to the source app. If Chrome refuses, AI Reader
falls back to the library and shows a pending or failed import row until the article is ready.

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
