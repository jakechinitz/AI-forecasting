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
  console.error('Missing OPENAI_API_KEY. Set it locally (export OPENAI_API_KEY=...) or add it as a GitHub Actions secret named OPENAI_API_KEY (repo Settings > Secrets and variables > Actions).');
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

STRUCTURE REQUIREMENTS (values placed elsewhere are silently ignored by the app):
- assumptionOverrides must have top-level keys among "demand", "efficiency", "supply", "financing". For demand/efficiency/supply, keys MUST be time-block keys (year1, year2, year3, year4, year5, years6_10, years11_15, years16_20), and inside each block use the same nested paths as the base assumptions file (e.g. {"demand": {"year1": {"inferenceGrowth": {"consumer": 1.5}}}}). The model starts in January of the year after FLEET_ANCHOR.asOfYearEnd, so year1 is that calendar year.
- "financing" follows FINANCING_ASSUMPTIONS_BASE: "scalars" and "baseYear" merge key by key; "paths" (priceChange, utilization, capexPerGw) are keyed by calendar year as strings (e.g. {"financing": {"paths": {"capexPerGw": {"2027": 64}}}}). "tiers" and "channels" are ARRAYS that replace the whole default array, so if you change either, return every element with every field.
- Growth rates are measured-token growth (Google/OpenAI/OpenRouter disclosures already include reasoning and agent-chain length), so do not add separate intensity growth for years 1-5.
- nodeOverrides must nest every node under a top-level "nodes" key, keyed by node id (e.g. {"nodes": {"hbm_stacks": {"startingCapacity": 8000000}}}). Do NOT include an "updateLog" key inside nodeOverrides; the update log is supplied separately via updateLogEntry.
- Only override node fields the model reads (startingCapacity, committedExpansions, yield fields, elasticityLong, maxAnnualExpansion, inputIntensity where applicable). Most component intensities live in TRANSLATION_INTENSITIES in the assumptions file, not on nodes.

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
          content: 'You are GPT. Your task is to update monthly assumptions and node baselines using current data. Be conservative with changes and explain them clearly.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'assumption_update',
          // strict mode is off because assumptionOverrides/nodeOverrides are
          // free-form objects (additionalProperties: true), which strict rejects.
          strict: false,
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
          }
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
    ?? result?.output
      ?.filter((item) => item.type === 'message')
      .flatMap((item) => item.content || [])
      .filter((content) => content?.type === 'output_text')
      .map((content) => content?.text)
      .find((text) => typeof text === 'string' && text.trim().length > 0);
  if (!outputText) {
    throw new Error(`No output text in OpenAI response. Raw response: ${limitText(JSON.stringify(result), 2000)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    throw new Error(`OpenAI returned invalid JSON: ${error.message}\n${limitText(outputText, 2000)}`);
  }
  if (!isPlainObject(parsed.assumptionOverrides) || !isPlainObject(parsed.nodeOverrides) || !isPlainObject(parsed.updateLogEntry)) {
    throw new Error(`OpenAI response missing expected keys. Got: ${Object.keys(parsed).join(', ')}`);
  }
  const mergedAssumptions = deepMerge(assumptionOverrides || {}, parsed.assumptionOverrides || {});

  // Defensive fixups: node overrides must live under a "nodes" key, and the
  // updateLog history must never be overwritten by model output (arrays merge
  // by replacement, so an echoed updateLog would truncate history).
  let nodePatch = parsed.nodeOverrides || {};
  delete nodePatch.updateLog;
  if (!isPlainObject(nodePatch.nodes) && Object.keys(nodePatch).length > 0) {
    console.warn('nodeOverrides missing "nodes" wrapper; wrapping model output.');
    nodePatch = { nodes: nodePatch };
  }
  const mergedNodes = deepMerge(nodeOverrides || {}, nodePatch);

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
