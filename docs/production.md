# Production Setup

The first production target is Vercel with Neon Postgres for articles and Vercel Blob for archived artifacts.

## Services

Create or connect these services in the Vercel project:

- Neon Postgres, which provides `DATABASE_URL`
- Vercel Blob, which provides `BLOB_READ_WRITE_TOKEN`
- Clerk, which provides `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`
- ElevenLabs, using the existing `ELEVENLABS_*` variables
- An Owner Only Instapaper Full API application
- A scoped Dropbox API application with Full Dropbox access

## Environment

Set these variables in Vercel for production and preview:

```bash
ARTICLE_REPOSITORY_DRIVER=postgres
ARTIFACT_STORAGE_DRIVER=vercel-blob
DATABASE_URL=...
BLOB_READ_WRITE_TOKEN=...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/
AI_READER_ALLOWED_EMAILS=you@example.com
AI_READER_INTEGRATION_OWNER_EMAIL=you@example.com
AI_READER_IMPORT_TOKEN=...
AI_READER_IMPORT_OWNER_EMAIL=you@example.com
INSTAPAPER_CONSUMER_KEY=...
INSTAPAPER_CONSUMER_SECRET=...
INSTAPAPER_ACCESS_TOKEN=...
INSTAPAPER_ACCESS_TOKEN_SECRET=...
DROPBOX_APP_KEY=...
DROPBOX_APP_SECRET=...
DROPBOX_REFRESH_TOKEN=...
OPENAI_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_COST_PER_1K_CHARS_USD=0
```

If Clerk keys are empty in production, the app shows a setup-required page and blocks the API.
Enable Google sign-in and any passkey options in Clerk. Keep `AI_READER_ALLOWED_EMAILS` set
for a personal deployment so arbitrary Google accounts cannot spend import or TTS budget.
The hosted app fails closed when that allowlist is empty.

Set `AI_READER_INTEGRATION_OWNER_EMAIL` to the one allowed account that owns the Instapaper and
Dropbox credentials below. Provider status and sync routes reject every other signed-in account,
even if it is also present in the broader app allowlist.

`AI_READER_IMPORT_TOKEN` is a separate bearer token for personal import clients such as the Chrome
extension or an optional direct iOS Shortcut. Generate a high-entropy value, for example with
`openssl rand -hex 32`, and never use a `NEXT_PUBLIC_` variable for it. Set
`AI_READER_IMPORT_OWNER_EMAIL` explicitly to the allowed account that owns imported articles.
The browser-opening iOS Shortcut described below uses the signed-in web session and does not need
the bearer token.

## Instapaper

1. Sign into the Instapaper account whose library will be imported and
   [register an application](https://www.instapaper.com/developers/applications/create).
2. Use a neutral title such as **AI Reader**, the deployed application URL, and the operator's
   contact email. Leave the application in **Owner Only** mode; review is unnecessary when the
   app developer and authenticated API user are the same person.
3. Copy the consumer key and one-time-displayed consumer secret into
   `INSTAPAPER_CONSUMER_KEY` and `INSTAPAPER_CONSUMER_SECRET`.
4. Use an OAuth 1.0a client with HMAC-SHA1 to sign this xAuth request:

   ```text
   POST https://www.instapaper.com/api/1/oauth/access_token
   Content-Type: application/x-www-form-urlencoded

   x_auth_username=EMAIL_OR_USERNAME
   x_auth_password=INSTAPAPER_PASSWORD_OR_EMPTY
   x_auth_mode=client_auth
   ```

   OAuth parameters belong in the `Authorization` header, and the three form fields must be part
   of the signature. Instapaper returns:

   ```text
   oauth_token=...&oauth_token_secret=...
   ```

5. Store those two values as `INSTAPAPER_ACCESS_TOKEN` and
   `INSTAPAPER_ACCESS_TOKEN_SECRET`. Discard the username and password immediately.

Instapaper's API does not exchange a Google token. If the account uses a Gmail address and has no
Instapaper password, keep the required `x_auth_password` field present but empty; Instapaper's
account conventions explicitly support passwordless accounts. If xAuth rejects it, set or reset an
Instapaper-specific password and use it only for the token exchange. The personal Owner Only
configuration can call `bookmarks/get_text` without an Instaparser key.

References:

- [Instapaper Full API authentication](https://www.instapaper.com/developers/v1/full-api/authentication)
- [Instapaper account conventions](https://www.instapaper.com/developers/overview/accounts-and-conventions)
- [Instapaper Bookmark API](https://www.instapaper.com/developers/v1/full-api/bookmark-api)
- [Instapaper API terms](https://www.instapaper.com/developers/overview/api-terms)

## Dropbox and @Voice Reader

@Voice writes its synchronized files under `/Apps/@Voice`. That folder belongs to @Voice, not to
AI Reader's Dropbox app sandbox, so create a [scoped Dropbox
app](https://www.dropbox.com/developers/apps/create) with **Full Dropbox** access. In the app's
Permissions tab, enable only:

- `account_info.read` for the basic account identity shown during authorization
- `files.metadata.read` for recursive folder listing
- `files.content.read` for downloading selected files

Do not enable write, sharing, or team scopes. Full Dropbox chooses which existing paths
the app can address; these read scopes constrain what it can do there. Dropbox explains the
[App folder versus Full Dropbox access
model](https://www.dropbox.com/developers/reference/developer-guide) and scoped permissions in its
[Getting Started guide](https://www.dropbox.com/developers/reference/getting-started).

Copy the app key and secret into `DROPBOX_APP_KEY` and `DROPBOX_APP_SECRET`, then obtain an offline
refresh token:

1. Open the following URL with the real app key substituted:

   ```text
   https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&response_type=code&token_access_type=offline
   ```

2. Approve the app and copy the displayed authorization code.
3. Exchange the code using HTTP Basic authentication:

   ```bash
   curl --request POST https://api.dropboxapi.com/oauth2/token \
     --user 'APP_KEY:APP_SECRET' \
     --data-urlencode 'code=AUTHORIZATION_CODE' \
     --data-urlencode 'grant_type=authorization_code'
   ```

4. Store the returned `refresh_token` as `DROPBOX_REFRESH_TOKEN`. AI Reader exchanges it
   server-side for short-lived access tokens and refreshes them before expiry.

The authorization URL must include `token_access_type=offline`; otherwise Dropbox does not return
a refresh token. If scopes change later, repeat authorization so the token receives the updated
grants. See Dropbox's official [OAuth
Guide](https://developers.dropbox.com/oauth-guide) and [HTTP API
reference](https://www.dropbox.com/developers/documentation/http/documentation).

The sync reads supported @Voice exports recursively from `/Apps/@Voice`, including
`.mhtml.zip`, MHTML, HTML, URL shortcuts, PDF, DOCX, Markdown, and text files. It never writes to or
deletes from Dropbox.

## AI discussion

Set `OPENAI_API_KEY` as a server-only production variable. Never prefix it with `NEXT_PUBLIC_`.
AI Reader uses `gpt-5.6-sol` with medium reasoning for typed, article-grounded discussion and
`gpt-realtime-2` for native speech-to-speech WebRTC sessions. The browser sends its WebRTC offer
to AI Reader; the server creates the OpenAI Realtime call, so the credential is never sent to the
browser.

For local development, AI Reader also recognizes the purpose-scoped shell variable
`OPENAI_API_KEY_AI_READER`. Shell startup files are plaintext on that computer; a macOS
Keychain-backed loader is safer when practical. Do not store the key in tracked files, synced
folders, client-side JavaScript, URLs, or logs.

References:

- [OpenAI GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Realtime WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc)

## Personal import clients

The token-authenticated endpoint is:

```http
POST /api/import
Authorization: Bearer AI_READER_IMPORT_TOKEN
Content-Type: application/json
Idempotency-Key: UNIQUE_REQUEST_ID

{"url":"https://example.com/article","title":"Optional title","source":"chrome-extension"}
```

Accepted source values are `api`, `android-share`, `chrome-extension`, and `ios-shortcut`.
`AI_READER_IMPORT_OWNER_EMAIL` determines article ownership. Keep the token out of URLs, logs,
screenshots, source control, and shared Shortcuts.
Keep each `Idempotency-Key` at 200 characters or fewer and never reuse it for a different URL or
title; AI Reader binds the first request fingerprint to that key.

### Package and install the Chrome extension

Validate and package the Manifest V3 extension from the repository root:

```bash
node --check integrations/chrome-extension/service-worker.js
node --check integrations/chrome-extension/options.js
node integrations/chrome-extension/scripts/validate.mjs
(
  cd integrations/chrome-extension
  zip -FSr ../../public/ai-reader-chrome-extension.zip \
    manifest.json service-worker.js options.html options.css options.js icons
)
unzip -l public/ai-reader-chrome-extension.zip
```

After deployment, download the ZIP from the app's **Integrations** panel or directly from:

```text
https://YOUR_AI_READER_ORIGIN/ai-reader-chrome-extension.zip
```

Unzip it, open `chrome://extensions` in Chrome, enable **Developer mode**, choose **Load
unpacked**, and select the extracted folder containing `manifest.json`. In the extension settings:

1. Enter the deployed AI Reader origin.
2. Paste `AI_READER_IMPORT_TOKEN`.
3. Grant the requested host access to that origin.
4. Test the toolbar button.
5. Confirm or assign `Command+Shift+Y` on macOS (`Ctrl+Shift+Y` elsewhere) at
   `chrome://extensions/shortcuts`.

Without a token, the extension safely falls back to opening `/share?url=...` and uses the existing
signed-in browser session. Tabs opened by the extension stay in the current tab group or a blue
**AI Reader** group. See Chrome's [unpacked-extension
instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
and [Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands).

### Install the Android share target

1. Open the deployed HTTPS origin in Chrome for Android and sign in.
2. Use Chrome's menu to choose **Install app** or **Add to Home screen**.
3. Launch the installed AI Reader once.
4. In a browser or another Android app, share an HTTP(S) article and choose **AI Reader**.

Android only exposes web share targets after the PWA is installed. If AI Reader was installed
before share support was deployed and does not appear, remove it and install it again. Shared URLs
are routed through `/api/share-target` to `/share` and imported using the signed-in app session.
See Chrome's [Web Share Target
documentation](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target).

### Create the iOS Share Sheet Shortcut

1. In Shortcuts on iPhone or iPad, create a shortcut named **Save to AI Reader**.
2. In Details, enable **Show in Share Sheet** and limit accepted input to **URLs** and
   **Safari web pages**.
3. Percent-encode the Shortcut Input.
4. Build this URL with the encoded value:

   ```text
   https://YOUR_AI_READER_ORIGIN/share?url=ENCODED_SHORTCUT_INPUT&source=ios-shortcut
   ```

5. Add **Open URLs** as the final action.
6. Keep Safari signed into the same AI Reader origin, then test from Safari's Share Sheet.

Opening `/share` avoids embedding the personal bearer token in a shareable Shortcut. For an
unattended direct-import Shortcut, call `/api/import` with `source: "ios-shortcut"` and the bearer
token, but treat that Shortcut as a credential and never share it. Apple documents how to
[enable a Shortcut in the Share
Sheet](https://support.apple.com/guide/shortcuts/launch-a-shortcut-from-another-app-apd163eb9f95/ios),
choose [Shortcut input
types](https://support.apple.com/guide/shortcuts/understanding-input-types-apd7644168e1/ios), and
use actions such as [Open
URLs](https://support.apple.com/guide/shortcuts/about-share-actions-apdaf74d75a5/ios).

## Database

After pulling production env vars locally:

```bash
vercel env pull .env.local --yes --environment=production
npm run db:migrate
```

Using the production env pull locally makes local development and Vercel point at the same
Postgres database. Check `ARTICLE_REPOSITORY_DRIVER=postgres` and `DATABASE_URL` in `.env.local`
after every env pull.

To copy the current ignored local JSON library into Postgres:

```bash
AI_READER_IMPORT_OWNER_EMAIL=you@example.com npm run db:import-local
```

To assign pre-existing unowned rows after adding ownership:

```bash
UPDATE articles SET owner_email = 'you@example.com' WHERE owner_email IS NULL OR owner_email = '';
```

For the current single-user deployment, `AI_READER_ALLOWED_EMAILS` is also the active access
boundary. Other Google accounts can sign in with Clerk, but the app returns access denied
unless their email is in that allowlist.

Legacy command, if `AI_READER_ALLOWED_EMAILS` is already set locally:

```bash
npm run db:import-local
```

## Deploy

```bash
npm run build
vercel --prod
```
