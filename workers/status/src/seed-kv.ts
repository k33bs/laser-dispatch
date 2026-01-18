/**
 * Seed script to populate KV with existing status entries without posting to Discord.
 * This prevents spam on first deployment.
 *
 * Run with: npm run seed
 *
 * Requires wrangler.toml to be configured with the KV namespace.
 */

import { execSync } from 'child_process';

interface StatusEntry {
  id: string;
  title: string;
  provider: string;
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved' | 'unknown';
}

function detectStatus(text: string): StatusEntry['status'] {
  const lower = text.toLowerCase();
  if (lower.includes('resolved') || lower.includes('completed') || lower.includes('恢复')) return 'resolved';
  if (lower.includes('monitoring')) return 'monitoring';
  if (lower.includes('identified')) return 'identified';
  if (lower.includes('investigating')) return 'investigating';
  return 'unknown';
}

interface FeedConfig {
  name: string;
  url: string;
  type: 'atom' | 'rss' | 'gcloud-json';
}

const FEEDS: FeedConfig[] = [
  { name: 'Claude', url: 'https://status.claude.com/history.atom', type: 'atom' },
  { name: 'OpenAI', url: 'https://status.openai.com/feed.atom', type: 'atom' },
  { name: 'Google AI', url: 'https://status.cloud.google.com/incidents.json', type: 'gcloud-json' },
  { name: 'Cursor', url: 'https://status.cursor.com/history.atom', type: 'atom' },
  { name: 'Windsurf', url: 'https://status.windsurf.com/history.atom', type: 'atom' },
  { name: 'Groq', url: 'https://groqstatus.com/feed.atom', type: 'atom' },
  { name: 'Bolt', url: 'https://status.bolt.new/feed.atom', type: 'atom' },
  { name: 'OpenRouter', url: 'https://status.openrouter.ai/incidents.rss', type: 'rss' },
  { name: 'Replicate', url: 'https://www.replicatestatus.com/feed.atom', type: 'atom' },
  { name: 'xAI', url: 'https://status.x.ai/feed.xml', type: 'rss' },
  { name: 'DeepSeek', url: 'https://status.deepseek.com/history.atom', type: 'atom' },
  { name: 'Perplexity', url: 'https://status.perplexity.com/history.atom', type: 'atom' },
  { name: 'Together AI', url: 'https://status.together.ai/feed.atom', type: 'atom' },
  { name: 'Cohere', url: 'https://status.cohere.com/feed.atom', type: 'atom' },
  { name: 'Lovable', url: 'https://status.lovable.dev/feed.atom', type: 'atom' },
];

const KV_BINDING = 'EAT_LASERS_STATUS_POSTED_CACHE';
const ONE_MONTH_SECONDS = 30 * 24 * 60 * 60;

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
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTextContent(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';
  let content = match[1];
  const cdataMatch = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch) content = cdataMatch[1];
  return stripHtml(decodeHtmlEntities(content));
}

function parseAtomFeed(xml: string, provider: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const id = extractTextContent(entry, 'id');
    const title = extractTextContent(entry, 'title');
    const content = extractTextContent(entry, 'content') || extractTextContent(entry, 'summary');
    entries.push({
      id: id || `${provider}-${Date.now()}`,
      title,
      provider,
      status: detectStatus(title + ' ' + content),
    });
  }
  return entries;
}

function parseRssFeed(xml: string, provider: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const guid = extractTextContent(item, 'guid');
    const link = extractTextContent(item, 'link');
    const title = extractTextContent(item, 'title');
    const description = extractTextContent(item, 'description');
    entries.push({
      id: guid || link || `${provider}-${Date.now()}`,
      title,
      provider,
      status: detectStatus(title + ' ' + description),
    });
  }
  return entries;
}

interface GCloudIncident {
  id: string;
  external_desc: string;
  end?: string;
  updates?: Array<{ text: string }>;
}

function parseGCloudJson(json: string, provider: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const incidents = JSON.parse(json) as GCloudIncident[];
  const aiKeywords = ['vertex', 'gemini', 'ai platform', 'ai studio', 'machine learning'];
  for (const incident of incidents) {
    const desc = incident.external_desc.toLowerCase();
    if (!aiKeywords.some(kw => desc.includes(kw))) continue;
    const latestUpdate = incident.updates?.[0]?.text || incident.external_desc;
    entries.push({
      id: incident.id,
      title: incident.external_desc,
      provider,
      status: incident.end ? 'resolved' : detectStatus(latestUpdate),
    });
  }
  return entries;
}

async function fetchEntries(config: FeedConfig): Promise<StatusEntry[]> {
  try {
    const response = await fetch(config.url, {
      headers: {
        'User-Agent': 'laser-dispatch-bot/1.0',
        'Accept': 'application/atom+xml, application/rss+xml, application/json, */*',
      },
    });
    if (!response.ok) return [];
    const text = await response.text();

    if (config.type === 'gcloud-json') return parseGCloudJson(text, config.name);
    if (config.type === 'atom') return parseAtomFeed(text, config.name);
    return parseRssFeed(text, config.name);
  } catch {
    return [];
  }
}

function writeToKV(key: string): void {
  try {
    execSync(
      `npx wrangler kv:key put --binding=${KV_BINDING} "${key}" "1" --ttl=${ONE_MONTH_SECONDS}`,
      { stdio: 'pipe' }
    );
  } catch (err) {
    console.error(`  ❌ Failed to write ${key}`);
  }
}

async function main() {
  console.log('🌱 Seeding KV with existing status entries...\n');

  let totalSeeded = 0;

  for (const feed of FEEDS) {
    console.log(`📡 ${feed.name}`);
    const entries = await fetchEntries(feed);

    for (const entry of entries) {
      const cacheKey = `status:${entry.id}:${entry.status}`;
      process.stdout.write(`  → [${entry.status}] ${entry.title.slice(0, 40)}...`);
      writeToKV(cacheKey);
      console.log(' ✅');
      totalSeeded++;
    }

    console.log(`  Seeded ${entries.length} entries\n`);
  }

  console.log(`\n✅ Done! Seeded ${totalSeeded} total entries.`);
  console.log('New status updates will now be posted to Discord on next run.');
}

main().catch(console.error);
