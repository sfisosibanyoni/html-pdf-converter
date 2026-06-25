# HTML → PDF Converter

Converts any HTML page to a pixel-perfect single-page PDF using a real headless Chrome engine. Images, web fonts, shadows, gradients — everything renders exactly as it would in a browser.

## Deploy to Vercel (5 minutes)

### Option A — Vercel CLI

```bash
npm install -g vercel
npm install
vercel
```

Follow the prompts. Vercel auto-detects the config from `vercel.json`.

### Option B — GitHub + Vercel Dashboard

1. Push this folder to a GitHub repository
2. Go to https://vercel.com/new
3. Import the repository
4. Click **Deploy** — no environment variables needed

Your app will be live at `https://your-project.vercel.app` in about 90 seconds.

## How it works

- **Frontend** (`public/index.html`) — paste HTML or upload a `.html` file, choose render width and quality
- **API** (`api/convert.js`) — serverless function that launches headless Chrome via `@sparticuz/chromium` (a Chromium build optimised for serverless/Lambda environments), renders the HTML with `networkidle0` so all images and fonts load, then exports a single-page PDF sized to the full content dimensions

## Key technical choices

| Choice | Reason |
|---|---|
| `@sparticuz/chromium` | Pre-built Chromium binary that fits within Vercel's 250 MB function limit |
| `puppeteer-core` | Uses the external Chromium rather than bundling its own |
| `networkidle0` | Waits for all network requests (images, fonts, stylesheets) to complete before capturing |
| Single-page PDF | Page dimensions set to the full scroll height of the content — no page breaks |
| `busboy` | Lightweight multipart parser for file uploads in serverless context |

## Limits (Vercel Hobby tier)

| Limit | Value |
|---|---|
| Function memory | 3 008 MB |
| Max execution time | 60 seconds |
| Max request body | 4.5 MB (upgrade for larger files) |

For heavier workloads, upgrade to Vercel Pro or self-host on a VPS with the included `server.js`.

## Local dev

```bash
npm install
npx vercel dev
```

Open http://localhost:3000
