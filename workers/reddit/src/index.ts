interface Env {
  EAT_LASERS_REDDIT_POSTED_CACHE: KVNamespace;
  EAT_LASERS_REDDIT_DISCORD_WEBHOOK_URL: string;
}

const SUBREDDITS = [
  "vibecoding",
  "vibecodedevs",
  "theVibeCoding",
  "cursor",
  "ClaudeAI",
  "ClaudeCode",
  "ChatGPTCoding",
  "Codex",
  "Anthropic",
  "OpenAI",
  "DeepSeek",
  "LLMDevs",
  "AI_Agents",
  "AIPromptProgramming",
  "windsurf",
  "Codeium",
  "replit",
  "githubcopilot",
  "PromptEngineering",
  "indiehackers",
  "nocode",
  "google_antigravity"
];

interface RedditPost {
  id: string;
  title: string;
  author: string;
  url: string;
  permalink: string;
  score: number;
  num_comments: number;
  subreddit: string;
  thumbnail: string;
  selftext: string;
  created_utc: number;
  is_self: boolean;
  post_hint?: string;
  preview?: {
    images: Array<{
      source: { url: string };
    }>;
  };
}

interface RedditResponse {
  data: {
    children: Array<{
      data: RedditPost;
    }>;
  };
}

const ONE_MONTH_SECONDS = 30 * 24 * 60 * 60;
const MAX_POSTS_PER_RUN = 10; // Limit posts per 1-min run
const DELAY_BETWEEN_POSTS_MS = 500; // Reduced delay, rely on 429 retry logic
const POISON_PILL_TTL_SECONDS = 24 * 60 * 60; // 24 hours for failed posts
const SUBREDDIT_FETCH_INTERVAL_MS = 10 * 60 * 1000; // Fetch each subreddit every 10 minutes
const MAX_SUBREDDITS_PER_RUN = 8; // Max subreddits to fetch per 1-min cron run (~8 req/min)

// Reddit API compliant User-Agent: <platform>:<app ID>:<version> (by /u/<username>)
const REDDIT_USER_AGENT = 'cloudflare:laser-dispatch:1.0 (by /u/_k33bs_)';

// Decode HTML entities from Reddit API responses
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&copy;/g, '©')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

async function fetchSubredditTop(subreddit: string): Promise<RedditPost[]> {
  const url = `https://www.reddit.com/r/${subreddit}/top.json?t=week&limit=10`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': REDDIT_USER_AGENT,
      },
    });

    if (response.status === 429) {
      console.warn(`Rate limited by Reddit on r/${subreddit}`);
      return [];
    }

    if (!response.ok) {
      console.error(`Failed to fetch r/${subreddit}: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as RedditResponse;
    return data.data?.children?.map((child) => child.data) || [];
  } catch (err) {
    console.error(`Error fetching/parsing r/${subreddit}:`, err);
    return [];
  }
}

function getPostImage(post: RedditPost): string | null {
  if (post.preview?.images?.[0]?.source?.url) {
    return post.preview.images[0].source.url.replace(/&amp;/g, '&');
  }

  if (post.thumbnail && post.thumbnail.startsWith('http')) {
    return post.thumbnail;
  }

  return null;
}

function createDiscordEmbed(post: RedditPost) {
  const redditUrl = `https://reddit.com${post.permalink}`;
  const image = getPostImage(post);
  const title = decodeHtmlEntities(post.title);

  const embed: Record<string, unknown> = {
    title: title.slice(0, 256),
    url: redditUrl,
    color: 0xff4500,
    author: {
      name: `r/${post.subreddit}`,
      url: `https://reddit.com/r/${post.subreddit}`,
      icon_url: 'https://www.redditstatic.com/desktop2x/img/favicon/android-icon-192x192.png',
    },
    fields: [
      {
        name: 'Score',
        value: `⬆️ ${post.score.toLocaleString()}`,
        inline: true,
      },
      {
        name: 'Comments',
        value: `💬 ${post.num_comments.toLocaleString()}`,
        inline: true,
      },
      {
        name: 'Author',
        value: `u/${post.author}`,
        inline: true,
      },
    ],
    timestamp: new Date(post.created_utc * 1000).toISOString(),
    footer: {
      text: 'Reddit',
      icon_url: 'https://www.redditstatic.com/desktop2x/img/favicon/android-icon-192x192.png',
    },
  };

  if (image) {
    embed.image = { url: image };
  }

  let description = '';

  // Add selftext for text posts
  if (post.selftext) {
    const selftext = decodeHtmlEntities(post.selftext);
    description = selftext.slice(0, 500) + (selftext.length > 500 ? '...' : '');
  }

  // Add external link if it's a link post
  if (!post.is_self && post.url !== redditUrl) {
    const linkText = `🔗 [External Link](${post.url})`;
    description = description ? `${description}\n\n${linkText}` : linkText;
  }

  if (description) {
    embed.description = description;
  }

  return embed;
}

interface PostResult {
  success: boolean;
  fatal: boolean; // true = permanent failure (4xx), false = transient (5xx/network)
}

async function postToDiscord(webhookUrl: string, post: RedditPost, retries = 3): Promise<PostResult> {
  const embed = createDiscordEmbed(post);

  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        embeds: [embed],
      }),
    });

    if (response.ok) {
      return { success: true, fatal: false };
    }

    // Handle rate limiting with retry
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const parsedRetry = retryAfter ? parseInt(retryAfter) : NaN;
      const waitMs = !isNaN(parsedRetry) ? parsedRetry * 1000 : (attempt + 1) * 1000;
      console.log(`Rate limited, waiting ${waitMs}ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    // 4xx client errors (except 429) are fatal - won't succeed on retry
    if (response.status >= 400 && response.status < 500) {
      console.error(`Discord rejected post (${response.status}): ${post.title.slice(0, 50)}`);
      return { success: false, fatal: true };
    }

    // Retry 5xx server errors
    if (response.status >= 500) {
      console.warn(`Discord server error (${response.status}), attempt ${attempt + 1}/${retries}`);
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
      continue;
    }

    console.error(`Failed to post to Discord: ${response.status}`);
    return { success: false, fatal: false };
  }

  console.error('Failed to post to Discord after retries');
  return { success: false, fatal: false }; // Transient - retry next run
}

interface PostCandidate {
  post: RedditPost;
  cacheKey: string;
}

async function getSubredditsDueForFetch(env: Env): Promise<string[]> {
  const now = Date.now();

  // Check last fetch time for all subreddits in parallel
  const checks = await Promise.all(
    SUBREDDITS.map(async (subreddit) => {
      const lastFetchKey = `lastfetch:${subreddit}`;
      const lastFetch = await env.EAT_LASERS_REDDIT_POSTED_CACHE.get(lastFetchKey);
      const isDue = !lastFetch || (now - parseInt(lastFetch)) >= SUBREDDIT_FETCH_INTERVAL_MS;
      return isDue ? subreddit : null;
    })
  );

  return checks.filter((s): s is string => s !== null);
}

async function markSubredditFetched(env: Env, subreddit: string): Promise<void> {
  const lastFetchKey = `lastfetch:${subreddit}`;
  await env.EAT_LASERS_REDDIT_POSTED_CACHE.put(lastFetchKey, Date.now().toString(), {
    expirationTtl: ONE_MONTH_SECONDS,
  });
}

async function collectNewPosts(env: Env): Promise<PostCandidate[]> {
  // Get subreddits that haven't been fetched in the last 10 minutes
  const dueSubreddits = await getSubredditsDueForFetch(env);

  if (dueSubreddits.length === 0) {
    console.log('No subreddits due for fetch');
    return [];
  }

  // Only fetch up to MAX_SUBREDDITS_PER_RUN to stay under rate limit
  const toFetch = dueSubreddits.slice(0, MAX_SUBREDDITS_PER_RUN);
  console.log(`Fetching ${toFetch.length}/${dueSubreddits.length} due subreddits: ${toFetch.join(', ')}`);

  const allPosts: RedditPost[] = [];

  // Fetch sequentially to be extra safe with rate limits
  for (const subreddit of toFetch) {
    const posts = await fetchSubredditTop(subreddit);
    if (posts.length > 0) {
      allPosts.push(...posts);
    }
    await markSubredditFetched(env, subreddit);

    // Small delay between requests
    if (toFetch.indexOf(subreddit) < toFetch.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log(`Fetched ${allPosts.length} posts from ${toFetch.length} subreddits`);

  // Check cache in parallel batches to find new posts
  const candidates: PostCandidate[] = [];
  const batchSize = 50;

  for (let i = 0; i < allPosts.length; i += batchSize) {
    const batch = allPosts.slice(i, i + batchSize);
    const cacheChecks = await Promise.all(
      batch.map(async (post) => {
        const cacheKey = `reddit:${post.id}`;
        const cached = await env.EAT_LASERS_REDDIT_POSTED_CACHE.get(cacheKey);
        return { post, cacheKey, cached: !!cached };
      })
    );

    for (const check of cacheChecks) {
      if (!check.cached) {
        candidates.push({ post: check.post, cacheKey: check.cacheKey });
      }
    }
  }

  // Sort by score descending so we post the best content first
  candidates.sort((a, b) => b.post.score - a.post.score);

  return candidates;
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log(`Processing ${SUBREDDITS.length} subreddits...`);

    const candidates = await collectNewPosts(env);
    console.log(`Found ${candidates.length} new posts to process`);

    let posted = 0;
    let failed = 0;
    const postsToProcess = candidates.slice(0, MAX_POSTS_PER_RUN);

    for (const { post, cacheKey } of postsToProcess) {
      const result = await postToDiscord(env.EAT_LASERS_REDDIT_DISCORD_WEBHOOK_URL, post);

      if (result.success) {
        await env.EAT_LASERS_REDDIT_POSTED_CACHE.put(cacheKey, '1', {
          expirationTtl: ONE_MONTH_SECONDS,
        });
        posted++;
        console.log(`Posted: [r/${post.subreddit}] ${post.title.slice(0, 50)}...`);
      } else if (result.fatal) {
        // Only cache 4xx errors as poison pills - these won't succeed on retry
        await env.EAT_LASERS_REDDIT_POSTED_CACHE.put(cacheKey, 'failed', {
          expirationTtl: POISON_PILL_TTL_SECONDS,
        });
        failed++;
        console.warn(`Failed (poison pill 24h): [r/${post.subreddit}] ${post.title.slice(0, 50)}...`);
      } else {
        // Transient error (5xx/network) - don't cache, will retry next run
        failed++;
        console.warn(`Failed (will retry): [r/${post.subreddit}] ${post.title.slice(0, 50)}...`);
      }

      // Short delay between posts
      if (posted + failed < postsToProcess.length) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_POSTS_MS));
      }
    }

    const skipped = candidates.length - postsToProcess.length;
    console.log(`Done! Posted: ${posted}, failed: ${failed}, skipped (over limit): ${skipped}`);
  },

  // HTTP handler for manual testing
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/trigger') {
      ctx.waitUntil(this.scheduled({} as ScheduledController, env, ctx));
      return new Response('OK', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  },
};
