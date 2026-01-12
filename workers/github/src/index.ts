interface Env {
  EAT_LASERS_GITHUB_POSTED_CACHE: KVNamespace;
  EAT_LASERS_GITHUB_DISCORD_WEBHOOK_URL: string;
  EAT_LASERS_GITHUB_TOKEN?: string;
}

const REPOS = [
  'anthropics/claude-code',
  'openai/codex',
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

async function postToDiscord(webhookUrl: string, commit: GitHubCommit, repo: string, retries = 3): Promise<boolean> {
  const embed = createDiscordEmbed(commit, repo);

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

async function processRepo(
  repo: string,
  env: Env
): Promise<{ posted: number; skipped: number }> {
  const commits = await fetchRepoCommits(repo, env.EAT_LASERS_GITHUB_TOKEN);
  let posted = 0;
  let skipped = 0;

  // Process in reverse to post oldest first
  for (const commit of commits.reverse()) {
    const cacheKey = `github:${commit.sha}`;
    const cached = await env.EAT_LASERS_GITHUB_POSTED_CACHE.get(cacheKey);

    if (cached) {
      skipped++;
      continue;
    }

    const success = await postToDiscord(env.EAT_LASERS_GITHUB_DISCORD_WEBHOOK_URL, commit, repo);

    if (success) {
      await env.EAT_LASERS_GITHUB_POSTED_CACHE.put(cacheKey, '1', {
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
    console.log(`Processing ${REPOS.length} repos...`);

    let totalPosted = 0;
    let totalSkipped = 0;

    for (const repo of REPOS) {
      const { posted, skipped } = await processRepo(repo, env);
      totalPosted += posted;
      totalSkipped += skipped;
      console.log(`${repo}: posted ${posted}, skipped ${skipped}`);
    }

    console.log(`Done! Total posted: ${totalPosted}, skipped: ${totalSkipped}`);
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
