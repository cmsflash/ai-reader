# AI Reader

Minimal web MVP for a Pocket/Instapaper-style reader.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Current MVP

- Save a URL and extract readable article content on the server, including paragraphs, headings, lists, quotes, code blocks, tables, and image alt/caption text.
- Upload PDF, DOCX, Markdown, or plain text documents.
- Store imported items as synced server-side article records through a repository adapter.
- Render a shared article library and reader.
- Sync reading position and current sentence through API updates.
- Read aloud with server-side ElevenLabs TTS, with browser SpeechSynthesis as a fallback.
- Double-click or double-tap a sentence to resume playback from that sentence.
- Track per-article processing API cost, defaulting to `$0.00` unless a provider cost rate is configured.
- Archive external article images into the app server store at import time so saved articles remain readable if source assets move or block hotlinks.

## Backend Architecture

The API routes call `src/server/articles/articleService.ts`. The service depends on ports, not concrete infrastructure:

- `src/server/ports/articleRepository.ts` stores article metadata, content, and progress.
- `src/server/ports/artifactStorage.ts` is the future boundary for originals and generated audio.
- `src/server/ports/importQueue.ts` is the future boundary for async extraction/TTS jobs.

External article images are copied into the artifact store during URL import and
served through `GET /api/artifacts/...`. `GET /api/image?url=...` remains as a
fallback read-time proxy for legacy or not-yet-archived image URLs. The image
fetcher uses browser-like headers and applies platform-specific referer handling
where required, such as WeChat `mmbiz.qpic.cn` images.

The current local adapter is `src/server/adapters/localJsonArticleRepository.ts`. It writes to `data/articles.json` by default.

Configure the local backend with:

```bash
ARTICLE_REPOSITORY_DRIVER=local-json
LOCAL_ARTICLE_STORE_PATH=data/articles.json
ARTIFACT_STORAGE_DRIVER=local-file
LOCAL_ARTIFACT_STORAGE_PATH=data/artifacts
```

Future platform adapters should implement the same ports:

- Firebase: Firestore repository, Cloud Storage artifact store, Cloud Functions/Tasks import queue.
- Supabase: Postgres repository, Supabase Storage artifact store, Edge Function or worker queue.
- Vercel/Neon: Postgres repository, Vercel Blob or S3/R2 artifact store, Vercel Queues/Inngest jobs.
- Normal backend: Postgres repository, S3-compatible storage, Redis/pg-boss/BullMQ worker queue.

## Text To Speech

The app uses a server-side TTS route at `POST /api/tts`. The browser sends text to the app server, and the server calls the configured TTS provider so provider keys never reach the client.

Local ElevenLabs configuration:

```bash
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_COST_PER_1K_CHARS_USD=0
```

`ELEVENLABS_COST_PER_1K_CHARS_USD` is optional. Set it only if you want local
estimated cost accounting for BYOK TTS calls; leaving it at `0` avoids hardcoded
provider pricing assumptions.

The browser SpeechSynthesis voice remains as a playback fallback if the server-side TTS call fails.

## Intentional Limits

- No auth yet.
- The store is a local JSON file, not a production database.
- Generated TTS audio is streamed on demand and not cached yet.
- URL extraction handles ordinary readable HTML and URL-linked PDFs, but hostile or heavily scripted pages may need an AI/browser extraction worker later.
