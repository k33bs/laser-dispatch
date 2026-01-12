# Reddit to Discord Worker

A Cloudflare Worker that fetches top posts from Reddit subreddits and posts them to Discord with nice embeds.

## Features

- Fetches top 10 posts of the day from multiple subreddits
- Deduplicates using KV storage (1 month TTL)
- Posts to Discord with rich embeds (images, scores, comments)
- Runs on a cron schedule (hourly by default)
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
wrangler kv:namespace create POSTED_CACHE
```

Copy the `id` from the output and update your `wrangler.toml`.

### 4. Configure subreddits

Edit the `SUBREDDITS` array in `src/index.ts`:

```typescript
const SUBREDDITS = [
  'programming',
  'webdev',
  'javascript',
];
```

### 5. Set secrets

```bash
wrangler secret put DISCORD_WEBHOOK_URL
```

### 6. Deploy

```bash
npm run deploy
```

## Development

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
