# Production Setup

The first production target is Vercel with Neon Postgres for articles and Vercel Blob for archived artifacts.

## Services

Create or connect these services in the Vercel project:

- Neon Postgres, which provides `DATABASE_URL`
- Vercel Blob, which provides `BLOB_READ_WRITE_TOKEN`
- Clerk, which provides `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`
- ElevenLabs, using the existing `ELEVENLABS_*` variables

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
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_COST_PER_1K_CHARS_USD=0
```

If Clerk keys are empty in production, the app shows a setup-required page and blocks the API.
Enable Google sign-in and any passkey options in Clerk. Keep `AI_READER_ALLOWED_EMAILS` set
for a personal deployment so arbitrary Google accounts cannot spend import or TTS budget.

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
