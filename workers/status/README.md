# AI Provider Status to Discord Worker

A Cloudflare Worker that monitors AI provider status pages and posts updates to Discord.

## Features

- Monitors 15 AI providers via RSS/Atom feeds
- Deduplicates using KV storage (1 month TTL)
- Posts to Discord with color-coded embeds
- Status detection (investigating, identified, monitoring, resolved)
- Only posts updates from the last 24 hours (prevents spam on first run)
- Runs on a cron schedule (every 10 minutes by default)

## Monitored Providers

| Provider | Status Page |
|----------|-------------|
| Claude | status.claude.com |
| OpenAI | status.openai.com |
| Google AI Studio | aistudio.google.com/status |
| Cursor | status.cursor.com |
| Windsurf | status.windsurf.com |
| Groq | groqstatus.com |
| Bolt | status.bolt.new |
| OpenRouter | status.openrouter.ai |
| Replicate | replicatestatus.com |
| xAI | status.x.ai |
| DeepSeek | status.deepseek.com |
| Perplexity | status.perplexity.com |
| Together AI | status.together.ai |
| Cohere | status.cohere.com |
| Lovable | status.lovable.dev |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Copy and configure wrangler.toml

```bash
cp wrangler.toml.example wrangler.toml
```

### 3. Create KV namespace

```bash
npx wrangler kv namespace create EAT_LASERS_STATUS_POSTED_CACHE
```

Copy the `id` from the output and update your `wrangler.toml`.

### 4. Set secrets (for production)

```bash
npx wrangler secret put EAT_LASERS_STATUS_DISCORD_WEBHOOK_URL
```

### 5. Seed KV (prevents spam on first run)

```bash
npm run seed
```

This populates the KV cache with existing status entries so only new updates get posted.

### 6. Deploy

```bash
npm run deploy
```

## Development

### Test feeds locally

```bash
npm run test:feeds
```

### Local secrets

Create a `.dev.vars` file for local testing (gitignored):

```
EAT_LASERS_STATUS_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your_webhook_here
```

### Run locally

```bash
npm run dev
```

Visit `http://localhost:8787/trigger` to manually trigger the worker.

## Status Colors

- 🔴 Investigating - Active incident being investigated
- 🟠 Identified - Root cause identified
- 🟡 Monitoring - Fix deployed, monitoring
- 🟢 Resolved - Incident resolved
- ⚪ Unknown - Status not detected
