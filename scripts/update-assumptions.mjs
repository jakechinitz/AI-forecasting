/**
 * Monthly AI Infrastructure Assumption Updater
 *
 * Fetches industry sources in parallel, sends them to an LLM with the current
 * assumption/node state, and writes conservative updates to the override files.
 *
 * Features:
 *   - Parallel source fetching with per-source timeout
 *   - Change magnitude validation: no single numeric value changes > ±15%
 *   - --dry-run flag to preview changes without writing
 *   - Detailed logging of what changed and why
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/update-assumptions.mjs
 *   OPENAI_API_KEY=sk-... node scripts/update-assumptions.mjs --dry-run
 *
 * Environment variables:
 *   OPENAI_API_KEY   (required)
 *   OPENAI_MODEL     (optional, default: gpt-4.1)
 *   OPENAI_BASE_URL  (optional, default: https://api.openai.com)
 *   MAX_CHANGE_PCT   (optional, default: 15 — max % any value can move per update)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ============================================
// CONFIG
// ============================================

const ROOT = process.cwd();
const SOURCES_PATH      = path.join(ROOT, 'scripts', 'assumption-sources.json');
const OVERRIDES_PATH    = path.join(ROOT, 'src', 'data', 'assumptionOverrides.json');
const NODE_OVR_PATH     = path.join(ROOT, 'src', 'data', 'nodesOverrides.json');
const ASSUMPTIONS_PATH  = path.join(ROOT, 'src', 'data', 'assumptions.js');
const NODES_PATH        = path.join(ROOT, 'src', 'data', 'nodes.js');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error('Missing OPENAI_API_KEY.'); process.exit(1); }

const MODEL         = process.env.OPENAI_MODEL    || 'gpt-4.1';
const BASE_URL      = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const MAX_CHANGE    = Number(process.env.MAX_CHANGE_PCT || 15) / 100; // 0.15
const DRY_RUN       = process.argv.includes('--dry-run');

const pad2 = (v) => String(v).padStart(2, '0');
const now  = new Date();
const currentMonth = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
const asOfDate     = `${currentMonth}-01`;

// ============================================
// HELPERS
// ============================================

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, overrides) {
  if (!isPlainObject(overrides)) return base;
  const merged = { ...base };
  for (const [key, val] of Object.entries(overrides)) {
    if (isPlainObject(val) && isPlainObject(base?.[key])) {
      merged[key] = deepMerge(base[key], val);
    } else {
      merged[key] = val;
    }
  }
  return merged;
}

const stripHtml = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const limitText = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf-8')); }
  catch { return null; }
}

// ============================================
// CHANGE MAGNITUDE VALIDATION
// ============================================

/**
 * Recursively walk two objects. For every leaf numeric value that exists in
 * both `prev` and `next`, clamp the change to ±maxDelta of the previous value.
 * Returns { result, warnings[] }.
 */
function clampChanges(prev, next, maxDelta, path = '') {
  const warnings = [];

  if (typeof next === 'number' && typeof prev === 'number' && prev !== 0) {
    const delta = (next - prev) / Math.abs(prev);
    if (Math.abs(delta) > maxDelta) {
      const clamped = +(prev * (1 + Math.sign(delta) * maxDelta)).toPrecision(6);
      warnings.push(`  Clamped ${path}: ${prev} → ${next} (${(delta * 100).toFixed(1)}%) → ${clamped}`);
      return { result: clamped, warnings };
    }
    return { result: next, warnings };
  }

  if (isPlainObject(next) && isPlainObject(prev)) {
    const out = { ...next };
    for (const [key, val] of Object.entries(next)) {
      if (prev[key] !== undefined) {
        const sub = clampChanges(prev[key], val, maxDelta, path ? `${path}.${key}` : key);
        out[key] = sub.result;
        warnings.push(...sub.warnings);
      }
    }
    return { result: out, warnings };
  }

  return { result: next, warnings };
}

// ============================================
// SOURCE FETCHING
// ============================================

async function fetchSource(source, timeoutMs, maxChars) {
  const { url, name, category } = typeof source === 'string'
    ? { url: source, name: source, category: 'unknown' }
    : source;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'AI-forecasting-assumptions-bot/2.0' },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timer);

    if (!resp.ok) return { url, name, category, ok: false, content: `HTTP ${resp.status}` };

    const raw = stripHtml(await resp.text());
    // Skip if very little usable content was extracted
    if (raw.length < 200) return { url, name, category, ok: false, content: 'Too little content after HTML strip' };

    return { url, name, category, ok: true, content: limitText(raw, maxChars) };
  } catch (err) {
    clearTimeout(timer);
    return { url, name, category, ok: false, content: `Fetch failed: ${err.message}` };
  }
}

async function fetchAllSources(sources, timeoutMs, maxChars) {
  console.log(`Fetching ${sources.length} sources in parallel...`);
  const results = await Promise.all(sources.map(s => fetchSource(s, timeoutMs, maxChars)));

  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);

  console.log(`  ${ok.length} succeeded, ${fail.length} failed`);
  if (fail.length > 0) {
    for (const f of fail) console.log(`    FAIL: ${f.name} — ${f.content}`);
  }

  return ok;
}

// ============================================
// LLM CALL
// ============================================

function buildPrompt(fetchedSources, assumptionsText, nodesText, assumptionOverrides, nodeOverrides) {
  const sourcesByCategory = {};
  for (const src of fetchedSources) {
    if (!sourcesByCategory[src.category]) sourcesByCategory[src.category] = [];
    sourcesByCategory[src.category].push({ name: src.name, url: src.url, content: src.content });
  }

  return `You are an AI infrastructure supply chain analyst performing a MONTHLY assumption update.

Current month: ${currentMonth}
As-of date: ${asOfDate}

## YOUR TASK
Review the fetched industry sources below. Update assumption values and node baselines ONLY where you find specific, citable evidence. Be conservative.

## RULES (CRITICAL)
1. **Max change per value: ±${(MAX_CHANGE * 100).toFixed(0)}%** — No single numeric value may move more than this from its previous value. Smaller changes are strongly preferred.
2. **Evidence required** — Every change must cite a specific source and data point. No speculative changes.
3. **Prefer no change** — If evidence is ambiguous or weak, leave the value unchanged.
4. **Near-term focus** — Prioritize Year 1-3 values where current data is most relevant. Long-term values (Years 6+) should rarely change.
5. **No structural changes** — Do not add/remove nodes, change node relationships, or modify input intensities (physical ratios).

## WHAT YOU CAN UPDATE

### assumptionOverrides (keyed by time-block: year1, year2, ... years16_20)
- **Demand growth rates**: inferenceGrowth.{consumer,enterprise,agentic}, trainingGrowth.{frontier,midtier}
- **Efficiency rates**: modelEfficiency.{m_inference,m_training}, systemsEfficiency.{s_inference,s_training}, hardwareEfficiency.{h,h_memory}
- **Supply expansion rates**: expansionRates.{packaging,foundry,memory,datacenter,power}

### nodeOverrides (keyed by node ID)
- **startingCapacity** — only if hard evidence of revised baseline (e.g., TSMC quarterly report shows different CoWoS capacity)
- **committedExpansions** — only if new capacity announcements with dates

## CURRENT STATE

### Base assumptions (JavaScript source — read for schema/values, do not rewrite):
${limitText(assumptionsText, 40000)}

### Base nodes (JavaScript source — read for schema/values, do not rewrite):
${limitText(nodesText, 40000)}

### Previous assumption overrides (your starting point — merge on top of these):
${JSON.stringify(assumptionOverrides, null, 2)}

### Previous node overrides (your starting point — merge on top of these):
${JSON.stringify(nodeOverrides, null, 2)}

## FETCHED SOURCES BY CATEGORY
${Object.entries(sourcesByCategory).map(([cat, srcs]) =>
  `### ${cat}\n${srcs.map(s => `**${s.name}** (${s.url}):\n${s.content}`).join('\n\n')}`
).join('\n\n')}

## OUTPUT FORMAT
Return valid JSON matching the schema exactly. For updateLogEntry.changes, list EVERY value you changed with the previous value, new value, and rationale citing the specific source.

If you find NO material changes warranted, return empty assumptionOverrides and nodeOverrides objects and explain in the summary why no changes were made.`;
}

async function callLLM(prompt) {
  console.log(`Calling ${MODEL} via ${BASE_URL}...`);

  const response = await fetch(`${BASE_URL}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      input: [
        {
          role: 'system',
          content: [{
            type: 'text',
            text: 'You are an expert AI infrastructure supply chain analyst. You produce monthly assumption updates based on real industry data. You are conservative — you only change values when specific evidence warrants it, and never by more than the stated limit per update cycle.'
          }]
        },
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }]
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'assumption_update',
          strict: true,
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
                  month:              { type: 'string' },
                  createdAt:          { type: 'string' },
                  summary:            { type: 'string' },
                  reasoning:          { type: 'string' },
                  materialHeadlines:  { type: 'array', items: { type: 'string' } },
                  sources: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        url:  { type: 'string' },
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
                        target:    { type: 'string' },
                        field:     { type: 'string' },
                        previous:  { type: 'string' },
                        next:      { type: 'string' },
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
    const errText = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${errText}`);
  }

  const result = await response.json();
  const outputText = result?.output_text;
  if (!outputText) throw new Error('No output_text in LLM response.');

  return JSON.parse(outputText);
}

// ============================================
// MAIN
// ============================================

async function main() {
  if (DRY_RUN) console.log('=== DRY RUN — no files will be written ===\n');

  // 1. Read current state
  const sourceConfig = await readJson(SOURCES_PATH);
  const sources = sourceConfig?.sources || [];
  const fetchTimeout = sourceConfig?.fetchTimeoutMs || 15000;
  const maxChars = sourceConfig?.maxContentCharsPerSource || 15000;

  const [assumptionOverrides, nodeOverrides, assumptionsText, nodesText] = await Promise.all([
    readJson(OVERRIDES_PATH),
    readJson(NODE_OVR_PATH),
    fs.readFile(ASSUMPTIONS_PATH, 'utf-8'),
    fs.readFile(NODES_PATH, 'utf-8')
  ]);

  // 2. Fetch all sources in parallel
  const fetched = await fetchAllSources(sources, fetchTimeout, maxChars);

  if (fetched.length === 0) {
    console.warn('WARNING: No sources returned usable content. Aborting.');
    process.exit(1);
  }

  // 3. Build prompt and call LLM
  const prompt = buildPrompt(fetched, assumptionsText, nodesText, assumptionOverrides || {}, nodeOverrides || {});
  console.log(`Prompt size: ~${(prompt.length / 1000).toFixed(0)}K chars`);

  const parsed = await callLLM(prompt);

  // 4. Validate & clamp changes
  const prevAssumptions = assumptionOverrides || {};
  const prevNodes = nodeOverrides || {};

  const clampedA = clampChanges(prevAssumptions, parsed.assumptionOverrides || {}, MAX_CHANGE);
  const clampedN = clampChanges(prevNodes, parsed.nodeOverrides || {}, MAX_CHANGE);

  if (clampedA.warnings.length > 0 || clampedN.warnings.length > 0) {
    console.log(`\nChange magnitude clamping (>${(MAX_CHANGE * 100).toFixed(0)}% moves capped):`);
    for (const w of [...clampedA.warnings, ...clampedN.warnings]) console.log(w);
  }

  // 5. Merge with existing overrides
  const mergedAssumptions = deepMerge(prevAssumptions, clampedA.result);
  const mergedNodes = deepMerge(prevNodes, clampedN.result);

  mergedAssumptions.metadata = { ...(mergedAssumptions.metadata || {}), asOfDate };

  const logEntry = {
    ...parsed.updateLogEntry,
    month: parsed.updateLogEntry.month || currentMonth,
    createdAt: parsed.updateLogEntry.createdAt || now.toISOString()
  };
  mergedNodes.updateLog = [logEntry, ...(mergedNodes.updateLog || [])];

  // 6. Log summary
  const changes = logEntry.changes || [];
  console.log(`\n--- Update Summary (${currentMonth}) ---`);
  console.log(`Sources used: ${fetched.length}/${sources.length}`);
  console.log(`Changes proposed: ${changes.length}`);
  console.log(`Summary: ${logEntry.summary}`);

  if (changes.length > 0) {
    console.log('\nChanges:');
    for (const c of changes) {
      console.log(`  ${c.target}.${c.field}: ${c.previous} → ${c.next}`);
      console.log(`    Rationale: ${c.rationale}`);
    }
  }

  if (logEntry.materialHeadlines?.length > 0) {
    console.log('\nMaterial headlines:');
    for (const h of logEntry.materialHeadlines) console.log(`  - ${h}`);
  }

  // 7. Write files
  if (DRY_RUN) {
    console.log('\n=== DRY RUN — skipping file writes ===');
    console.log('\nWould write assumptionOverrides:', JSON.stringify(mergedAssumptions, null, 2).slice(0, 500) + '...');
    console.log('\nWould write nodeOverrides:', JSON.stringify(mergedNodes, null, 2).slice(0, 500) + '...');
  } else {
    await fs.writeFile(OVERRIDES_PATH, JSON.stringify(mergedAssumptions, null, 2) + '\n');
    await fs.writeFile(NODE_OVR_PATH, JSON.stringify(mergedNodes, null, 2) + '\n');
    console.log('\nOverride files updated successfully.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
