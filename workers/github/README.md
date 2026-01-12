# GitHub to Discord Worker

A Cloudflare Worker that fetches commits from GitHub repos and posts them to Discord with nice embeds.

## Features

- Fetches latest 10 commits from multiple repos
- Deduplicates using KV storage (1 month TTL)
- Posts to Discord with rich embeds (commit message, author, link)
- Runs on a cron schedule (hourly by default)
- Optional GitHub token for private repos or higher rate limits
- Manual trigger endpoint for testing

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
npx wrangler kv namespace create EAT_LASERS_GITHUB_POSTED_CACHE
```

Copy the `id` from the output and update your `wrangler.toml`.

### 4. Configure repos

Edit the `REPOS` array in `src/index.ts`:

```typescript
const REPOS = [
  'anthropics/claude-code',
  'openai/codex',
  'owner/repo',
];
```

### 5. Set secrets (for production)

```bash
npx wrangler secret put EAT_LASERS_GITHUB_DISCORD_WEBHOOK_URL

# Optional: for private repos or higher rate limits
npx wrangler secret put EAT_LASERS_GITHUB_TOKEN
```

### 6. Deploy

```bash
npm run deploy
```

## Development

### Local secrets

Create a `.dev.vars` file for local testing (gitignored):

```
EAT_LASERS_GITHUB_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your_webhook_here
EAT_LASERS_GITHUB_TOKEN=ghp_your_token_here
```

### Run locally

```bash
npm run dev
```

Visit `http://localhost:8787/trigger` to manually trigger the worker.

## Configuration

Edit `wrangler.toml` to change the cron schedule:

```toml
[triggers]
crons = ["0 * * * *"]  # Every hour
```

Common cron patterns:
- `0 * * * *` - Every hour
- `*/30 * * * *` - Every 30 minutes
- `0 */6 * * *` - Every 6 hours
- `0 9 * * *` - Daily at 9 AM UTC
