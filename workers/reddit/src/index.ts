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
  "nocode"
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

async function fetchSubredditTop(subreddit: string): Promise<RedditPost[]> {
  const url = `https://www.reddit.com/r/${subreddit}/top.json?t=day&limit=10`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'laser-dispatch-bot/1.0',
    },
  });

  if (!response.ok) {
    console.error(`Failed to fetch r/${subreddit}: ${response.status}`);
    return [];
  }

  const data = (await response.json()) as RedditResponse;
  return data.data.children.map((child) => child.data);
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

  const embed: Record<string, unknown> = {
    title: post.title.slice(0, 256),
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

  if (post.selftext && !post.is_self) {
    embed.description = post.selftext.slice(0, 300) + (post.selftext.length > 300 ? '...' : '');
  }

  if (!post.is_self && post.url !== redditUrl) {
    embed.description = `🔗 [External Link](${post.url})`;
  }

  return embed;
}

async function postToDiscord(webhookUrl: string, post: RedditPost, retries = 3): Promise<boolean> {
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
      return true;
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : (attempt + 1) * 2000;
      console.log(`Rate limited, waiting ${waitMs}ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    console.error(`Failed to post to Discord: ${response.status}`);
    return false;
  }

  console.error('Failed to post to Discord after retries');
  return false;
}

async function processSubreddit(
  subreddit: string,
  env: Env
): Promise<{ posted: number; skipped: number }> {
  const posts = await fetchSubredditTop(subreddit);
  let posted = 0;
  let skipped = 0;

  for (const post of posts) {
    const cacheKey = `reddit:${post.id}`;
    const cached = await env.EAT_LASERS_REDDIT_POSTED_CACHE.get(cacheKey);

    if (cached) {
      skipped++;
      continue;
    }

    const success = await postToDiscord(env.EAT_LASERS_REDDIT_DISCORD_WEBHOOK_URL, post);

    if (success) {
      await env.EAT_LASERS_REDDIT_POSTED_CACHE.put(cacheKey, '1', {
        expirationTtl: ONE_MONTH_SECONDS,
      });
      posted++;

      // Rate limit: wait 2 seconds between posts to avoid Discord rate limits
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  return { posted, skipped };
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log(`Processing ${SUBREDDITS.length} subreddits...`);

    let totalPosted = 0;
    let totalSkipped = 0;

    for (const subreddit of SUBREDDITS) {
      const { posted, skipped } = await processSubreddit(subreddit, env);
      totalPosted += posted;
      totalSkipped += skipped;
      console.log(`r/${subreddit}: posted ${posted}, skipped ${skipped}`);
    }

    console.log(`Done! Total posted: ${totalPosted}, skipped: ${totalSkipped}`);
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
      return new Response('Triggered!', { status: 200 });
    }

    return new Response('Reddit to Discord Worker\n\nGET /trigger - manually trigger the cron job', {
      status: 200,
    });
  },
};
