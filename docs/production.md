# Production Setup

The first production target is Vercel with Neon Postgres for articles and Vercel Blob for archived artifacts.

## Services

Create or connect these services in the Vercel project:

- Neon Postgres, which provides `DATABASE_URL`
- Vercel Blob, which provides `BLOB_READ_WRITE_TOKEN`
- ElevenLabs, using the existing `ELEVENLABS_*` variables

## Environment

Set these variables in Vercel for production and preview:

```bash
ARTICLE_REPOSITORY_DRIVER=postgres
ARTIFACT_STORAGE_DRIVER=vercel-blob
DATABASE_URL=...
BLOB_READ_WRITE_TOKEN=...
AI_READER_AUTH_USERNAME=reader
AI_READER_AUTH_PASSWORD=...
AI_READER_SESSION_SECRET=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_COST_PER_1K_CHARS_USD=0
```

If `AI_READER_AUTH_PASSWORD` or `AI_READER_SESSION_SECRET` is empty in production, the app
shows a setup-required login page and blocks the API.

## Database

After pulling production env vars locally:

```bash
vercel env pull .env.local --yes --environment=production
npm run db:migrate
```

To copy the current ignored local JSON library into Postgres:

```bash
npm run db:import-local
```

## Deploy

```bash
npm run build
vercel --prod
```
