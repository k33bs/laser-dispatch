interface Env {
  EAT_LASERS_STATUS_POSTED_CACHE: KVNamespace;
  EAT_LASERS_STATUS_DISCORD_WEBHOOK_URL: string;
}

interface StatusEntry {
  id: string;
  title: string;
  link: string;
  updated: Date;
  content: string;
  provider: string;
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved' | 'unknown';
}

interface FeedConfig {
  name: string;
  url: string;
  type: 'atom' | 'rss' | 'gcloud-json';
  color: number;
}

const FEEDS: FeedConfig[] = [
  { name: 'Claude', url: 'https://status.claude.com/history.atom', type: 'atom', color: 0xD4A574 },
  { name: 'OpenAI', url: 'https://status.openai.com/feed.atom', type: 'atom', color: 0x00A67E },
  { name: 'Google AI', url: 'https://status.cloud.google.com/incidents.json', type: 'gcloud-json', color: 0x4285F4 },
  { name: 'Cursor', url: 'https://status.cursor.com/history.atom', type: 'atom', color: 0x000000 },
  { name: 'Windsurf', url: 'https://status.windsurf.com/history.atom', type: 'atom', color: 0x00D4AA },
  { name: 'Groq', url: 'https://groqstatus.com/feed.atom', type: 'atom', color: 0xF55036 },
  { name: 'Bolt', url: 'https://status.bolt.new/feed.atom', type: 'atom', color: 0x7C3AED },
  { name: 'OpenRouter', url: 'https://status.openrouter.ai/incidents.rss', type: 'rss', color: 0x6366F1 },
  { name: 'Replicate', url: 'https://www.replicatestatus.com/feed.atom', type: 'atom', color: 0x000000 },
  { name: 'xAI', url: 'https://status.x.ai/feed.xml', type: 'rss', color: 0x000000 },
  { name: 'DeepSeek', url: 'https://status.deepseek.com/history.atom', type: 'atom', color: 0x0066FF },
  { name: 'Perplexity', url: 'https://status.perplexity.com/history.atom', type: 'atom', color: 0x20B8CD },
  { name: 'Together AI', url: 'https://status.together.ai/feed.atom', type: 'atom', color: 0x0EA5E9 },
  { name: 'Cohere', url: 'https://status.cohere.com/feed.atom', type: 'atom', color: 0x39594D },
  { name: 'Lovable', url: 'https://status.lovable.dev/feed.atom', type: 'atom', color: 0xEC4899 },
];

const ONE_MONTH_SECONDS = 30 * 24 * 60 * 60;
const POISON_PILL_TTL_SECONDS = 24 * 60 * 60; // 24 hours for failed entries
const STATUS_FETCH_BATCH_SIZE = 5; // Fetch 5 status feeds at a time
const STATUS_BATCH_DELAY_MS = 1000; // Short delay between batches

// Decode HTML entities from status feed responses
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&copy;/g, '©')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

// Strip HTML tags and clean up whitespace
function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')  // Replace tags with space
    .replace(/\s+/g, ' ')       // Collapse multiple spaces
    .trim();
}

function extractTextContent(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';

  let content = match[1];
  const cdataMatch = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch) {
    content = cdataMatch[1];
  }

  // Decode HTML entities first, then strip any remaining HTML tags
  return stripHtml(decodeHtmlEntities(content));
}

function extractAttribute(xml: string, tag: string, attr: string): string {
  const regex = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*>`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : '';
}

function detectStatus(text: string): StatusEntry['status'] {
  const lower = text.toLowerCase();
  if (lower.includes('resolved') || lower.includes('completed') || lower.includes('恢复')) return 'resolved';
  if (lower.includes('monitoring')) return 'monitoring';
  if (lower.includes('identified')) return 'identified';
  if (lower.includes('investigating')) return 'investigating';
  return 'unknown';
}

function parseAtomFeed(xml: string, config: FeedConfig): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const id = extractTextContent(entry, 'id');
    const title = extractTextContent(entry, 'title');
    const updated = extractTextContent(entry, 'updated');
    const content = extractTextContent(entry, 'content') || extractTextContent(entry, 'summary');
    const link = extractAttribute(entry, 'link', 'href');

    entries.push({
      id: id || `${config.name}-${Date.now()}`,
      title,
      link,
      updated: new Date(updated),
      content,
      provider: config.name,
      status: detectStatus(title + ' ' + content),
    });
  }

  return entries;
}

function parseRssFeed(xml: string, config: FeedConfig): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];

    const title = extractTextContent(item, 'title');
    const link = extractTextContent(item, 'link');
    const guid = extractTextContent(item, 'guid');
    const pubDate = extractTextContent(item, 'pubDate');
    const description = extractTextContent(item, 'description');

    entries.push({
      id: guid || link || `${config.name}-${Date.now()}`,
      title,
      link,
      updated: new Date(pubDate),
      content: description,
      provider: config.name,
      status: detectStatus(title + ' ' + description),
    });
  }

  return entries;
}

interface GCloudIncident {
  id: string;
  number: string;
  begin: string;
  end?: string;
  modified: string;
  external_desc: string;
  updates: Array<{
    text: string;
    when: string;
  }>;
}

function parseGCloudJson(json: string, config: FeedConfig): StatusEntry[] {
  const entries: StatusEntry[] = [];

  try {
    const incidents = JSON.parse(json) as GCloudIncident[];

    // Filter for AI/Vertex/Gemini related incidents
    const aiKeywords = ['vertex', 'gemini', 'ai platform', 'ai studio', 'machine learning'];

    for (const incident of incidents) {
      const desc = incident.external_desc.toLowerCase();
      const isAiRelated = aiKeywords.some(keyword => desc.includes(keyword));

      if (!isAiRelated) continue;

      const latestUpdate = incident.updates?.[0]?.text || incident.external_desc;
      const isResolved = !!incident.end;

      entries.push({
        id: incident.id,
        title: incident.external_desc,
        link: `https://status.cloud.google.com/incidents/${incident.id}`,
        updated: new Date(incident.modified),
        content: latestUpdate.slice(0, 500),
        provider: config.name,
        status: isResolved ? 'resolved' : detectStatus(latestUpdate),
      });
    }
  } catch (err) {
    console.error(`Error parsing Google Cloud JSON: ${err}`);
  }

  return entries;
}

async function fetchFeed(config: FeedConfig): Promise<StatusEntry[]> {
  try {
    const response = await fetch(config.url, {
      headers: {
        'User-Agent': 'laser-dispatch-bot/1.0',
        'Accept': 'application/atom+xml, application/rss+xml, application/json, application/xml, text/xml, */*',
      },
    });

    if (!response.ok) {
      console.error(`Failed to fetch ${config.name}: ${response.status}`);
      return [];
    }

    const text = await response.text();

    if (config.type === 'gcloud-json') {
      return parseGCloudJson(text, config);
    }

    if (config.type === 'atom') {
      return parseAtomFeed(text, config);
    } else {
      return parseRssFeed(text, config);
    }
  } catch (err) {
    console.error(`Error fetching ${config.name}: ${err}`);
    return [];
  }
}

function getStatusEmoji(status: StatusEntry['status']): string {
  switch (status) {
    case 'investigating': return '🔴';
    case 'identified': return '🟠';
    case 'monitoring': return '🟡';
    case 'resolved': return '🟢';
    default: return '⚪';
  }
}

function createDiscordEmbed(entry: StatusEntry, config: FeedConfig) {
  const embed: Record<string, unknown> = {
    title: `${getStatusEmoji(entry.status)} ${entry.title.slice(0, 200)}`,
    url: entry.link,
    color: config.color,
    author: {
      name: entry.provider,
      url: entry.link,
    },
    timestamp: entry.updated.toISOString(),
    footer: {
      text: `Status: ${entry.status.charAt(0).toUpperCase() + entry.status.slice(1)}`,
    },
  };

  if (entry.content) {
    embed.description = entry.content.slice(0, 500) + (entry.content.length > 500 ? '...' : '');
  }

  return embed;
}

interface PostResult {
  success: boolean;
  fatal: boolean; // true = permanent failure (4xx), false = transient (5xx/network)
}

async function postToDiscord(webhookUrl: string, entry: StatusEntry, config: FeedConfig, retries = 3): Promise<PostResult> {
  const embed = createDiscordEmbed(entry, config);

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
        console.error(`Discord rejected entry (${response.status}): ${entry.title.slice(0, 50)}`);
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

interface EntryCandidate {
  entry: StatusEntry;
  config: FeedConfig;
  cacheKey: string;
}

async function collectAllEntries(env: Env): Promise<{ candidates: EntryCandidate[]; skipped: number }> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const allEntries: { entry: StatusEntry; config: FeedConfig }[] = [];

  // Fetch feeds in batches
  for (let i = 0; i < FEEDS.length; i += STATUS_FETCH_BATCH_SIZE) {
    const batch = FEEDS.slice(i, i + STATUS_FETCH_BATCH_SIZE);
    console.log(`Fetching batch ${Math.floor(i / STATUS_FETCH_BATCH_SIZE) + 1}: ${batch.map(f => f.name).join(', ')}`);

    const fetchResults = await Promise.allSettled(
      batch.map(config => fetchFeed(config).then(entries => ({ entries, config })))
    );

    for (const result of fetchResults) {
      if (result.status === 'fulfilled') {
        for (const entry of result.value.entries) {
          allEntries.push({ entry, config: result.value.config });
        }
      }
    }

    // Wait between batches (except after last batch)
    if (i + STATUS_FETCH_BATCH_SIZE < FEEDS.length) {
      await new Promise(resolve => setTimeout(resolve, STATUS_BATCH_DELAY_MS));
    }
  }

  console.log(`Fetched ${allEntries.length} total entries from ${FEEDS.length} feeds`);

  // Filter and check cache
  const candidates: EntryCandidate[] = [];
  let skipped = 0;

  for (const { entry, config } of allEntries) {
    // Skip invalid dates
    if (isNaN(entry.updated.getTime())) {
      continue;
    }

    // Skip old entries
    if (entry.updated < oneDayAgo) {
      continue;
    }

    const cacheKey = `status:${entry.id}:${entry.status}`;
    const cached = await env.EAT_LASERS_STATUS_POSTED_CACHE.get(cacheKey);

    if (cached) {
      skipped++;
      continue;
    }

    candidates.push({ entry, config, cacheKey });
  }

  return { candidates, skipped };
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log(`Processing ${FEEDS.length} status feeds...`);

    const { candidates, skipped } = await collectAllEntries(env);
    console.log(`Found ${candidates.length} new entries, ${skipped} already posted`);

    let posted = 0;
    let failed = 0;

    for (const { entry, config, cacheKey } of candidates) {
      const result = await postToDiscord(env.EAT_LASERS_STATUS_DISCORD_WEBHOOK_URL, entry, config);

      if (result.success) {
        await env.EAT_LASERS_STATUS_POSTED_CACHE.put(cacheKey, '1', {
          expirationTtl: ONE_MONTH_SECONDS,
        });
        posted++;
        console.log(`Posted: [${config.name}] ${entry.title.slice(0, 50)}...`);
      } else if (result.fatal) {
        // Only cache 4xx errors as poison pills
        await env.EAT_LASERS_STATUS_POSTED_CACHE.put(cacheKey, 'failed', {
          expirationTtl: POISON_PILL_TTL_SECONDS,
        });
        failed++;
        console.warn(`Failed (poison pill 24h): [${config.name}] ${entry.title.slice(0, 50)}...`);
      } else {
        // Transient error - don't cache, will retry next run
        failed++;
        console.warn(`Failed (will retry): [${config.name}] ${entry.title.slice(0, 50)}...`);
      }

      // Short delay between posts
      if (posted + failed < candidates.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`Done! Posted: ${posted}, failed: ${failed}, skipped: ${skipped}`);
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
