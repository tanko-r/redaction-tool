// Browser-based LLM filter — supports WebLLM (in-browser) and Ollama (localhost).
import { BATCH_SIZE } from './constants.js';

let webllmEngine = null;
let webllmLoading = false;
let activeBackend = null; // 'webllm' | 'ollama' | null

const OLLAMA_URL = 'http://localhost:11434';
const CTX_CHARS = 80;

// ── Prompt builder (same as detectors/llm.js) ──────────────────────────────

function buildContext(context, value) {
  const idx = context.indexOf(value);
  if (idx === -1) {
    return context.length > CTX_CHARS * 2 ? '...' + context.slice(-(CTX_CHARS * 2)) : context;
  }
  const lo = Math.max(0, idx - CTX_CHARS);
  const hi = Math.min(context.length, idx + value.length + CTX_CHARS);
  return (lo > 0 ? '...' : '') + context.slice(lo, hi) + (hi < context.length ? '...' : '');
}

function buildPrompt(items) {
  const lines = items.map((c, i) => {
    const ctx = buildContext(c.context, c.detection.value);
    return `${i + 1}. [${c.detection.type}] "${c.detection.value}" in: "${ctx}"`;
  });

  return (
    `Classify each entity: Y = redact (real name), N = keep (generic term).\n\n` +
    `EXAMPLES:\n` +
    `[PERSON] "James A. Carter" → Y (real person name)\n` +
    `[PERSON] "Elena Vasquez" → Y (real person name)\n` +
    `[PERSON] "Thomas R. Bennett Jr." → Y (real person name)\n` +
    `[PERSON] "the Guarantor" → N (generic role, not a name)\n` +
    `[PERSON] "Beneficiary" → N (generic role)\n` +
    `[PERSON] "Lender" → N (generic role)\n` +
    `[ORG] "Greenfield Properties LLC" → Y (specific company — has LLC)\n` +
    `[ORG] "Apex Commercial Lending Inc" → Y (specific company — has Inc)\n` +
    `[ORG] "Northstar Capital Advisors" → Y (specific firm name)\n` +
    `[ORG] "Columbia River Electric" → Y (specific utility company)\n` +
    `[ORG] "Portland Development Commission" → Y (specific government agency)\n` +
    `[ORG] "Redwood Equity Partners" → Y (specific firm name)\n` +
    `[ORG] "Secured Party" → N (generic role)\n` +
    `[ORG] "Escrow Company" → N (generic placeholder)\n` +
    `[ORG] "Settlement Agent" → N (generic role)\n` +
    `[ORG] "Review Board" → N (generic body)\n` +
    `[ORG] "Substantial Damage" → N (legal defined term)\n` +
    `[ORG] "Partial Condemnation" → N (legal defined term)\n` +
    `[ORG] "Act of God" → N (legal defined term)\n` +
    `[ORG] "Commencement Date" → N (legal defined term)\n` +
    `[ORG] "Cure Notice" → N (legal defined term)\n` +
    `[ORG] "Excluded Assets" → N (legal defined term)\n` +
    `[ORG] "Clark County" → N (jurisdiction)\n` +
    `[ORG] "Oregon State" → N (jurisdiction)\n\n` +
    `Key: [PERSON] "Firstname Lastname" → Y. [PERSON] "X Party" → N. Fragments → N.\n\n` +
    `NOW CLASSIFY:\n` +
    lines.join('\n')
  );
}

// ── WebLLM backend ──────────────────────────────────────────────────────────

const WEBLLM_MODEL = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';

export async function loadWebLLM(onProgress = () => {}) {
  if (webllmEngine) return;
  if (webllmLoading) return;
  webllmLoading = true;

  try {
    const webllm = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.78/+esm');

    // Check WebGPU support
    if (!navigator.gpu) {
      throw new Error('WebGPU not available in this browser');
    }

    webllmEngine = await webllm.CreateMLCEngine(WEBLLM_MODEL, {
      initProgressCallback: (progress) => {
        onProgress(progress);
      },
    });
    activeBackend = 'webllm';
  } catch (err) {
    webllmEngine = null;
    throw err;
  } finally {
    webllmLoading = false;
  }
}

async function runWebLLMBatch(batch) {
  const prompt = buildPrompt(batch);

  // Build the expected JSON keys
  const keys = batch.map((_, i) => String(i + 1));

  const reply = await webllmEngine.chat.completions.create({
    messages: [
      { role: 'system', content: 'You are a classification assistant. Respond only with a JSON object mapping item numbers to Y or N.' },
      { role: 'user', content: prompt + '\n\nRespond with JSON like {"1":"Y","2":"N",...}' },
    ],
    temperature: 0,
    max_tokens: batch.length * 12,
    response_format: { type: 'json_object' },
  });

  const raw = reply.choices[0].message.content.trim();

  try {
    const obj = JSON.parse(raw);
    const verdicts = keys.map(k => String(obj[k] || 'Y').toUpperCase().trim());
    return { verdicts, prompt, raw };
  } catch {
    // Fallback: scan for Y/N tokens
    const tokens = raw.match(/\b[YN]\b/gi);
    if (tokens && tokens.length >= batch.length) {
      return { verdicts: tokens.slice(0, batch.length).map(t => t.toUpperCase()), prompt, raw };
    }
    // Fail open
    return { verdicts: batch.map(() => 'Y'), prompt, raw };
  }
}

// ── Ollama backend ──────────────────────────────────────────────────────────

export async function checkOllama() {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return { available: false, models: [] };
    const data = await resp.json();
    return { available: true, models: (data.models || []).map(m => m.name) };
  } catch {
    return { available: false, models: [] };
  }
}

async function runOllamaBatch(batch, model) {
  const prompt = buildPrompt(batch);

  const properties = {};
  const required = [];
  for (let i = 0; i < batch.length; i++) {
    const k = String(i + 1);
    properties[k] = { type: 'string', enum: ['Y', 'N'] };
    required.push(k);
  }
  const format = { type: 'object', properties, required };

  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, prompt, stream: false, format,
      options: { temperature: 0, num_predict: batch.length * 12 },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const data = await resp.json();
  const raw = (data.response || '').trim();

  try {
    const obj = JSON.parse(raw);
    const verdicts = batch.map((_, i) => String(obj[String(i + 1)] ?? 'Y').toUpperCase().trim());
    return { verdicts, prompt, raw };
  } catch {
    const tokens = raw.match(/\b[YN]\b/gi);
    if (tokens && tokens.length >= batch.length) {
      return { verdicts: tokens.slice(0, batch.length).map(t => t.toUpperCase()), prompt, raw };
    }
    return { verdicts: batch.map(() => 'Y'), prompt, raw };
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getLLMBackend() {
  return activeBackend;
}

export function isLLMReady() {
  return activeBackend !== null;
}

export function setBackend(backend) {
  activeBackend = backend;
}

/**
 * Run LLM filter on candidates. Processes in batches.
 * @param {Array} candidates — [{detection, context}]
 * @param {Function} onBatch — (batchNum, totalBatches, approvedCount, rejectedCount)
 * @param {string|null} ollamaModel — Ollama model name if using Ollama backend
 * @returns {Promise<{approved: Set<number>, llmLog: Array}>}
 */
export async function llmFilter(candidates, onBatch = () => {}, ollamaModel = null) {
  const approved = new Set();
  const llmLog = [];

  if (!candidates.length || !activeBackend) {
    // If no LLM backend, approve everything (fail open)
    candidates.forEach((_, i) => approved.add(i));
    return { approved, llmLog };
  }

  const totalBatches = Math.ceil(candidates.length / BATCH_SIZE);

  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + BATCH_SIZE);
    const batchNum = Math.floor(offset / BATCH_SIZE) + 1;

    try {
      let result;
      if (activeBackend === 'webllm') {
        result = await runWebLLMBatch(batch);
      } else if (activeBackend === 'ollama') {
        result = await runOllamaBatch(batch, ollamaModel || 'qwen2.5:1.5b-instruct');
      } else {
        // No backend — approve all
        batch.forEach((_, i) => approved.add(offset + i));
        continue;
      }

      const items = batch.map((c, i) => ({
        value:   c.detection.value,
        type:    c.detection.type,
        source:  c.detection.source,
        verdict: result.verdicts[i],
      }));
      llmLog.push({ prompt: result.prompt, response: result.raw, items });

      let approvedCount = 0;
      result.verdicts.forEach((v, i) => {
        if (v === 'Y') { approved.add(offset + i); approvedCount++; }
      });

      onBatch(batchNum, totalBatches, approvedCount, batch.length - approvedCount);
    } catch (err) {
      console.error(`LLM batch ${batchNum} failed:`, err.message);
      // Fail open
      batch.forEach((_, i) => approved.add(offset + i));
      llmLog.push({ prompt: '(failed)', response: err.message, items: [] });
      onBatch(batchNum, totalBatches, batch.length, 0);
    }
  }

  return { approved, llmLog };
}
