# AI Reader Chrome Extension

Manifest V3 extension for saving the active HTTP(S) page to AI Reader from the toolbar or a
keyboard shortcut.

## Install locally

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this `integrations/chrome-extension` directory.
3. The settings page opens in an **AI Reader** tab group. Enter the origin of the deployed reader,
   such as `https://reader.example.com`.
4. Optionally paste a scoped personal import token.

The default shortcut is `Ctrl+Shift+Y` (`Command+Shift+Y` on macOS). Chrome may leave a suggested
shortcut unassigned if it conflicts with another command. Use **Change Chrome shortcut** in the
settings page, or open `chrome://extensions/shortcuts`, to assign any available combination.

## Save behavior

- With a personal import token, the extension sends:

  ```http
  POST {AI_READER_ORIGIN}/api/import
  Authorization: Bearer {TOKEN}
  Content-Type: application/json
  Idempotency-Key: {UUID}

  {"url":"https://example.com/article","title":"Article title","source":"chrome-extension"}
  ```

  Any `2xx` response counts as accepted. The request is aborted after 25 seconds so it stays within
  Chrome extension service-worker limits.

- Without a token, it opens:

  ```text
  {AI_READER_ORIGIN}/share?url={ENCODED_URL}&title={ENCODED_TITLE}
  ```

  This path relies on the existing browser login. Tabs opened by the extension are added to the
  current tab group, or to a new blue **AI Reader** group.

The token is stored only in `chrome.storage.local`; it is not bundled into the extension or synced
through Chrome.

## Regenerate icons and validate

The icons are generated entirely with Node built-ins:

```bash
node scripts/generate-icons.mjs
node --check service-worker.js
node --check options.js
node scripts/validate.mjs
```
