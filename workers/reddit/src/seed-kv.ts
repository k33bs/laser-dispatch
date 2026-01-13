/**
 * Seed script to populate KV with existing Reddit posts without posting to Discord.
 * This prevents spam on first deployment.
 *
 * Run with: npm run seed
 *
 * Requires wrangler.toml to be configured with the KV namespace.
 */

import { execSync } from 'child_process';

const SUBREDDITS = [
  'vibecoding',
  'vibecodedevs',
  'theVibeCoding',
  'cursor',
  'ClaudeAI',
  'ClaudeCode',
  'ChatGPTCoding',
  'Codex',
  'Anthropic',
  'OpenAI',
  'DeepSeek',
  'LLMDevs',
  'AI_Agents',
  'AIPromptProgramming',
  'windsurf',
  'Codeium',
  'replit',
  'githubcopilot',
  'PromptEngineering',
  'indiehackers',
  'nocode',
];

interface RedditPost {
  id: string;
  title: string;
  subreddit: string;
  score: number;
}

interface RedditResponse {
  data: {
    children: Array<{
      data: RedditPost;
    }>;
  };
}

const KV_BINDING = 'EAT_LASERS_REDDIT_POSTED_CACHE';
const ONE_MONTH_SECONDS = 30 * 24 * 60 * 60;
// Browser-like User-Agent for local seeding (Reddit blocks bot-like agents from non-CF IPs)
const REDDIT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchSubredditTop(subreddit: string): Promise<RedditPost[]> {
  // Use old.reddit.com - more reliable for JSON API
  const url = `https://old.reddit.com/r/${subreddit}/top.json?t=week&limit=10`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': REDDIT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      console.error(`  Failed to fetch r/${subreddit}: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as RedditResponse;
    return data.data?.children?.map((child) => child.data) || [];
  } catch (err) {
    console.error(`  Error fetching r/${subreddit}:`, err);
    return [];
  }
}

function writeToKV(key: string, value: string = '1'): void {
  try {
    execSync(
      `npx wrangler kv:key put --binding=${KV_BINDING} "${key}" "${value}" --ttl=${ONE_MONTH_SECONDS}`,
      { stdio: 'pipe' }
    );
  } catch (err) {
    console.error(`  Failed to write ${key}`);
  }
}

async function main() {
  console.log('Seeding KV with existing Reddit posts...\n');

  let totalSeeded = 0;
  const now = Date.now();

  for (const subreddit of SUBREDDITS) {
    console.log(`r/${subreddit}`);

    // Rate limit: wait between requests (Reddit is strict)
    if (SUBREDDITS.indexOf(subreddit) > 0) {
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }

    const posts = await fetchSubredditTop(subreddit);

    for (const post of posts) {
      const cacheKey = `reddit:${post.id}`;
      process.stdout.write(`  -> [${post.score}] ${post.title.slice(0, 45)}...`);
      writeToKV(cacheKey);
      console.log(' done');
      totalSeeded++;
    }

    // Also seed the lastfetch timestamp so staggered fetching works
    const lastFetchKey = `lastfetch:${subreddit}`;
    writeToKV(lastFetchKey, now.toString());

    console.log(`  Seeded ${posts.length} posts + lastfetch timestamp\n`);
  }

  console.log(`\nDone! Seeded ${totalSeeded} total posts.`);
  console.log('New Reddit posts will now be posted to Discord on next run.');
}

main().catch(console.error);
