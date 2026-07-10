# Thesis Writing Assistant — Previous Studies Builder

A static HTML/CSS/JavaScript app that helps students analyze a thesis introduction,
search real studies via Semantic Scholar, get AI writing suggestions, collect notes,
and generate a "Previous Studies and Related Topics" section.

The frontend (`index.html`, `style.css`, `app.js`) is plain vanilla JS — no framework,
no build step. All calls to OpenAI and Semantic Scholar are proxied through small
Vercel serverless functions in `/api`, so API keys stay on the server and are never
sent to the browser.

## Project structure

```
index.html                    Frontend markup (unchanged)
style.css                     Styling (unchanged)
app.js                        Frontend logic — calls local /api routes only
api/openai-chat.js            Proxies OpenAI chat completions
api/openai-tts.js             Proxies OpenAI text-to-speech
api/semantic-scholar-search.js Proxies Semantic Scholar paper search
api/_lib/errors.js            Shared error-response helpers (not a route)
```

## Local development

**Requirements:** Node.js 18+ and the Vercel CLI (installed automatically via `npx`).

1. Install dependencies (none required beyond Node itself, but this sets up the project):
   ```bash
   npm install
   ```

2. Copy the environment template and fill in your real keys:
   ```bash
   cp .env.example .env.local
   ```
   Edit `.env.local`:
   ```
   OPENAI_API_KEY=sk-...
   SEMANTIC_SCHOLAR_API_KEY=...
   ```
   `.env.local` is gitignored and never committed.

   > Semantic Scholar's search endpoint also works without a key (at a lower rate
   > limit), so `SEMANTIC_SCHOLAR_API_KEY` can be left blank if you don't have one.

3. Start the local dev server (serves the static frontend and the `/api` functions together):
   ```bash
   npm start
   ```
   This runs `vercel dev`. On first run it may ask you to link/create a Vercel project —
   choose the defaults (no framework preset needed, this is a static + serverless-functions project).

   > Note: the script is named `start` rather than `dev` on purpose — the Vercel CLI
   > refuses to run if it finds a `package.json` script literally named `dev` that
   > calls `vercel dev` (it treats this as a recursive self-invocation).

4. Open the URL it prints (typically `http://localhost:3000`).

## Deploying to Vercel

1. Push this project to a Git repository (GitHub/GitLab/Bitbucket) or run `vercel` from the CLI.
2. In the Vercel project dashboard, go to **Settings → Environment Variables** and add:
   - `OPENAI_API_KEY`
   - `SEMANTIC_SCHOLAR_API_KEY`
3. Deploy. No build command is required — Vercel serves the static files and picks up
   the `/api` folder as serverless functions automatically.

## Error handling

The `/api` routes return clear JSON error messages (surfaced in the UI or browser
console) for:
- Missing environment variables on the server
- Invalid/expired API keys
- Rate limiting / quota errors
- General upstream API failures or network errors

## Security note

Never put real API keys in `app.js`, `index.html`, or any file that ships to the
browser. Keys belong only in `.env.local` (local dev, gitignored) or in the Vercel
project's Environment Variables (deployment).
