interface Env {
  EAT_LASERS_GITHUB_POSTED_CACHE: KVNamespace;
  EAT_LASERS_GITHUB_DISCORD_WEBHOOK_URL: string;
  EAT_LASERS_GITHUB_TOKEN?: string;
}

const REPOS = [
  'k33bs/laser-dispatch',
  'k33bs/HellPad',
  'k33bs/vibedeck'
  // Add more repos here
];

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    };
  };
  author: {
    login: string;
    avatar_url: string;
    html_url: string;
  } | null;
  html_url: string;
}

const ONE_MONTH_SECONDS = 30 * 24 * 60 * 60;
const POISON_PILL_TTL_SECONDS = 24 * 60 * 60; // 24 hours for failed posts
const DELAY_BETWEEN_POSTS_MS = 500; // Reduced delay, rely on 429 retry logic

interface PostResult {
  success: boolean;
  fatal: boolean; // true = permanent failure (4xx), false = transient (5xx/network)
}

async function fetchRepoCommits(repo: string, token?: string): Promise<GitHubCommit[]> {
  const url = `https://api.github.com/repos/${repo}/commits?per_page=10`;

  const headers: Record<string, string> = {
    'User-Agent': 'laser-dispatch-bot/1.0',
    'Accept': 'application/vnd.github.v3+json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    console.error(`Failed to fetch ${repo}: ${response.status}`);
    return [];
  }

  return (await response.json()) as GitHubCommit[];
}

function createDiscordEmbed(commit: GitHubCommit, repo: string) {
  const messageLines = commit.commit.message.split('\n');
  const title = messageLines[0].slice(0, 256);
  const description = messageLines.slice(1).join('\n').trim().slice(0, 500);

  const embed: Record<string, unknown> = {
    title: title,
    url: commit.html_url,
    color: 0x238636,
    author: {
      name: repo,
      url: `https://github.com/${repo}`,
      icon_url: 'https://github.githubassets.com/favicons/favicon.png',
    },
    fields: [
      {
        name: 'Commit',
        value: `[\`${commit.sha.slice(0, 7)}\`](${commit.html_url})`,
        inline: true,
      },
      {
        name: 'Author',
        value: commit.author
          ? `[@${commit.author.login}](${commit.author.html_url})`
          : commit.commit.author.name,
        inline: true,
      },
    ],
    timestamp: commit.commit.author.date,
    footer: {
      text: 'GitHub',
      icon_url: 'https://github.githubassets.com/favicons/favicon.png',
    },
  };

  if (description) {
    embed.description = description + (commit.commit.message.length > 500 ? '...' : '');
  }

  if (commit.author?.avatar_url) {
    embed.thumbnail = { url: commit.author.avatar_url };
  }

  return embed;
}

async function postToDiscord(webhookUrl: string, commit: GitHubCommit, repo: string, retries = 3): Promise<PostResult> {
  const embed = createDiscordEmbed(commit, repo);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
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
        console.error(`Discord rejected commit (${response.status}): ${commit.sha.slice(0, 7)}`);
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
    } catch (err) {
      // Network errors (DNS, timeout, etc.) - retry
      console.warn(`Network error posting to Discord (attempt ${attempt + 1}/${retries}):`, err);
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }

  console.error('Failed to post to Discord after retries');
  return { success: false, fatal: false }; // Transient - retry next run
}

interface CommitCandidate {
  commit: GitHubCommit;
  cacheKey: string;
}

async function processRepo(
  repo: string,
  env: Env
): Promise<{ posted: number; skipped: number; failed: number }> {
  const commits = await fetchRepoCommits(repo, env.EAT_LASERS_GITHUB_TOKEN);

  if (commits.length === 0) {
    return { posted: 0, skipped: 0, failed: 0 };
  }

  // Check cache in parallel for all commits
  const cacheChecks = await Promise.all(
    commits.map(async (commit) => {
      const cacheKey = `github:${commit.sha}`;
      const cached = await env.EAT_LASERS_GITHUB_POSTED_CACHE.get(cacheKey);
      return { commit, cacheKey, cached: !!cached };
    })
  );

  // Filter to only new commits, reverse to post oldest first
  const candidates: CommitCandidate[] = cacheChecks
    .filter((c) => !c.cached)
    .map(({ commit, cacheKey }) => ({ commit, cacheKey }))
    .reverse();

  let posted = 0;
  let skipped = cacheChecks.filter((c) => c.cached).length;
  let failed = 0;

  for (const { commit, cacheKey } of candidates) {
    const result = await postToDiscord(env.EAT_LASERS_GITHUB_DISCORD_WEBHOOK_URL, commit, repo);

    if (result.success) {
      await env.EAT_LASERS_GITHUB_POSTED_CACHE.put(cacheKey, '1', {
        expirationTtl: ONE_MONTH_SECONDS,
      });
      posted++;
      console.log(`Posted: [${repo}] ${commit.sha.slice(0, 7)}`);
    } else if (result.fatal) {
      // Only cache 4xx errors as poison pills
      await env.EAT_LASERS_GITHUB_POSTED_CACHE.put(cacheKey, 'failed', {
        expirationTtl: POISON_PILL_TTL_SECONDS,
      });
      failed++;
      console.warn(`Failed (poison pill 24h): [${repo}] ${commit.sha.slice(0, 7)}`);
    } else {
      // Transient error - don't cache, will retry next run
      failed++;
      console.warn(`Failed (will retry): [${repo}] ${commit.sha.slice(0, 7)}`);
    }

    // Short delay between posts
    if (posted + failed < candidates.length) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_POSTS_MS));
    }
  }

  return { posted, skipped, failed };
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log(`Processing ${REPOS.length} repos...`);

    let totalPosted = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (const repo of REPOS) {
      const { posted, skipped, failed } = await processRepo(repo, env);
      totalPosted += posted;
      totalSkipped += skipped;
      totalFailed += failed;
      console.log(`${repo}: posted ${posted}, skipped ${skipped}, failed ${failed}`);
    }

    console.log(`Done! Posted: ${totalPosted}, skipped: ${totalSkipped}, failed: ${totalFailed}`);
  },

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
