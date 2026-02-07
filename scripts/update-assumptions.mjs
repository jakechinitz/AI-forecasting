import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SOURCES_PATH = path.join(ROOT, 'scripts', 'assumption-sources.json');
const ASSUMPTION_OVERRIDES_PATH = path.join(ROOT, 'src', 'data', 'assumptionOverrides.json');
const NODE_OVERRIDES_PATH = path.join(ROOT, 'src', 'data', 'nodesOverrides.json');
const ASSUMPTIONS_PATH = path.join(ROOT, 'src', 'data', 'assumptions.js');
const NODES_PATH = path.join(ROOT, 'src', 'data', 'nodes.js');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY.');
  process.exit(1);
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';

const pad2 = (value) => String(value).padStart(2, '0');
const now = new Date();
const currentMonth = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
const asOfDate = `${currentMonth}-01`;

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const deepMerge = (base, overrides) => {
  if (!isPlainObject(overrides)) return base;
  const merged = { ...base };
  Object.entries(overrides).forEach(([key, value]) => {
    if (isPlainObject(value) && isPlainObject(base?.[key])) {
      merged[key] = deepMerge(base[key], value);
    } else {
      merged[key] = value;
    }
  });
  return merged;
};

const stripHtml = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const limitText = (text, max = 12000) => (text.length > max ? `${text.slice(0, max)}…` : text);

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

async function fetchSource(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AI-forecasting-assumptions-bot/1.0'
      }
    });
    const text = await response.text();
    return {
      url,
      status: response.status,
      ok: response.ok,
      content: limitText(stripHtml(text))
    };
  } catch (error) {
    return {
      url,
      status: 0,
      ok: false,
      content: `Fetch failed: ${error.message}`
    };
  }
}

async function main() {
  const sourceConfig = await readJson(SOURCES_PATH);
  const sources = sourceConfig?.sources || [];

  const [assumptionOverrides, nodeOverrides, assumptionsText, nodesText] = await Promise.all([
    readJson(ASSUMPTION_OVERRIDES_PATH),
    readJson(NODE_OVERRIDES_PATH),
    fs.readFile(ASSUMPTIONS_PATH, 'utf-8'),
    fs.readFile(NODES_PATH, 'utf-8')
  ]);

  const fetchedSources = [];
  for (const url of sources) {
    fetchedSources.push(await fetchSource(url));
  }

  const prompt = `You are updating monthly AI infrastructure assumptions.
Purpose: produce accurate, reasonable forecasts tied to the most recent month and near-term outlook (next month), improving medium/long-term projections (6+ months to years). Use prior estimates as the base, only changing values if there is material new evidence.

Return JSON only, following the schema. Include a concise reasoning log that references the sources and highlights what changed vs the prior month.

Current month: ${currentMonth}
As-of date: ${asOfDate}

Base assumptions file (for context, do not rewrite):\n${limitText(assumptionsText, 60000)}

Base nodes file (for context, do not rewrite):\n${limitText(nodesText, 60000)}

Prior assumption overrides (your baseline for updates):\n${JSON.stringify(assumptionOverrides, null, 2)}

Prior node overrides (your baseline for updates):\n${JSON.stringify(nodeOverrides, null, 2)}

Fetched sources (scraped, use what is relevant):\n${JSON.stringify(fetchedSources, null, 2)}
`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'You are GPT. Your task is to update monthly assumptions and node baselines using current data. Be conservative with changes and explain them clearly.'
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'assumption_update',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              assumptionOverrides: { type: 'object', additionalProperties: true },
              nodeOverrides: { type: 'object', additionalProperties: true },
              updateLogEntry: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  month: { type: 'string' },
                  createdAt: { type: 'string' },
                  summary: { type: 'string' },
                  reasoning: { type: 'string' },
                  materialHeadlines: { type: 'array', items: { type: 'string' } },
                  sources: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        url: { type: 'string' },
                        note: { type: 'string' }
                      },
                      required: ['url', 'note']
                    }
                  },
                  changes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        target: { type: 'string' },
                        field: { type: 'string' },
                        previous: { type: 'string' },
                        next: { type: 'string' },
                        rationale: { type: 'string' }
                      },
                      required: ['target', 'field', 'previous', 'next', 'rationale']
                    }
                  }
                },
                required: ['month', 'createdAt', 'summary', 'reasoning', 'materialHeadlines', 'sources', 'changes']
              }
            },
            required: ['assumptionOverrides', 'nodeOverrides', 'updateLogEntry']
          },
          strict: true
        }
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  const outputText = result?.output_text
    ?? result?.output?.flatMap((item) => item.content || [])
      .map((content) => content?.text)
      .find((text) => typeof text === 'string' && text.trim().length > 0);
  if (!outputText) {
    throw new Error('No output_text in OpenAI response.');
  }

  const parsed = JSON.parse(outputText);
  const mergedAssumptions = deepMerge(assumptionOverrides || {}, parsed.assumptionOverrides || {});
  const mergedNodes = deepMerge(nodeOverrides || {}, parsed.nodeOverrides || {});

  mergedAssumptions.metadata = {
    ...(mergedAssumptions.metadata || {}),
    asOfDate
  };

  const updateLogEntry = {
    ...parsed.updateLogEntry,
    month: parsed.updateLogEntry.month || currentMonth,
    createdAt: parsed.updateLogEntry.createdAt || new Date().toISOString()
  };

  mergedNodes.updateLog = [updateLogEntry, ...(mergedNodes.updateLog || [])];

  await fs.writeFile(ASSUMPTION_OVERRIDES_PATH, JSON.stringify(mergedAssumptions, null, 2) + '\n');
  await fs.writeFile(NODE_OVERRIDES_PATH, JSON.stringify(mergedNodes, null, 2) + '\n');

  console.log('Assumption overrides updated.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
