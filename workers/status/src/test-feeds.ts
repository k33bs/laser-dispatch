/**
 * Test script to fetch and parse all status feeds
 * Run with: npm run test:feeds
 */

interface StatusEntry {
  id: string;
  title: string;
  link: string;
  updated: Date;
  content: string;
  provider: string;
  status?: 'investigating' | 'identified' | 'monitoring' | 'resolved' | 'unknown';
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

function extractTextContent(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';

  // Handle CDATA
  let content = match[1];
  const cdataMatch = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch) {
    content = cdataMatch[1];
  }

  // Strip HTML tags for plain text
  return content.replace(/<[^>]+>/g, '').trim();
}

function extractAttribute(xml: string, tag: string, attr: string): string {
  const regex = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*>`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : '';
}

function parseAtomFeed(xml: string, provider: string): StatusEntry[] {
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
      id: id || `${provider}-${Date.now()}`,
      title,
      link,
      updated: new Date(updated),
      content,
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

    const title = extractTextContent(item, 'title');
    const link = extractTextContent(item, 'link');
    const guid = extractTextContent(item, 'guid');
    const pubDate = extractTextContent(item, 'pubDate');
    const description = extractTextContent(item, 'description');

    entries.push({
      id: guid || link || `${provider}-${Date.now()}`,
      title,
      link,
      updated: new Date(pubDate),
      content: description,
      provider,
      status: detectStatus(title + ' ' + description),
    });
  }

  return entries;
}

function detectStatus(text: string): StatusEntry['status'] {
  const lower = text.toLowerCase();
  if (lower.includes('resolved') || lower.includes('completed')) return 'resolved';
  if (lower.includes('monitoring')) return 'monitoring';
  if (lower.includes('identified')) return 'identified';
  if (lower.includes('investigating')) return 'investigating';
  return 'unknown';
}

interface GCloudIncident {
  id: string;
  external_desc: string;
  modified: string;
  end?: string;
  updates: Array<{ text: string }>;
}

function parseGCloudJson(json: string, provider: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const incidents = JSON.parse(json) as GCloudIncident[];
  const aiKeywords = ['vertex', 'gemini', 'ai platform', 'ai studio', 'machine learning'];

  for (const incident of incidents) {
    const desc = incident.external_desc.toLowerCase();
    if (!aiKeywords.some(kw => desc.includes(kw))) continue;

    entries.push({
      id: incident.id,
      title: incident.external_desc,
      link: `https://status.cloud.google.com/incidents/${incident.id}`,
      updated: new Date(incident.modified),
      content: incident.updates?.[0]?.text?.slice(0, 200) || '',
      provider,
      status: incident.end ? 'resolved' : detectStatus(incident.updates?.[0]?.text || ''),
    });
  }
  return entries;
}

async function fetchFeed(config: FeedConfig): Promise<{ config: FeedConfig; entries: StatusEntry[]; error?: string; raw?: string }> {
  try {
    const response = await fetch(config.url, {
      headers: {
        'User-Agent': 'laser-dispatch-bot/1.0',
        'Accept': 'application/atom+xml, application/rss+xml, application/json, application/xml, text/xml, */*',
      },
    });

    if (!response.ok) {
      return { config, entries: [], error: `HTTP ${response.status}` };
    }

    const text = await response.text();

    let entries: StatusEntry[];
    if (config.type === 'gcloud-json') {
      entries = parseGCloudJson(text, config.name);
    } else if (config.type === 'atom') {
      entries = parseAtomFeed(text, config.name);
    } else {
      entries = parseRssFeed(text, config.name);
    }

    return { config, entries };
  } catch (err) {
    return { config, entries: [], error: String(err) };
  }
}

async function main() {
  console.log('Testing status feeds...\n');
  console.log('='.repeat(80));

  for (const feed of FEEDS) {
    console.log(`\n📡 ${feed.name} (${feed.type})`);
    console.log(`   URL: ${feed.url}`);

    const result = await fetchFeed(feed);

    if (result.error) {
      console.log(`   ❌ Error: ${result.error}`);
      continue;
    }

    if (result.raw) {
      console.log(`   ℹ️  HTML page - needs custom parsing`);
      console.log(`   Preview: ${result.raw.slice(0, 200)}...`);
      continue;
    }

    console.log(`   ✅ Found ${result.entries.length} entries`);

    if (result.entries.length > 0) {
      const latest = result.entries[0];
      console.log(`   Latest: ${latest.title.slice(0, 60)}${latest.title.length > 60 ? '...' : ''}`);
      console.log(`   Date: ${latest.updated.toISOString()}`);
      console.log(`   Status: ${latest.status}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('\nDone!');
}

main().catch(console.error);
