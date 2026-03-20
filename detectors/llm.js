/**
 * LLM-based second-opinion filter using a local Ollama model.
 * Called only for low-confidence detections to reduce false positives.
 */

const OLLAMA_URL   = 'http://localhost:11434/api/generate';
const MODEL        = 'llama3.2:2b';
const BATCH_SIZE   = 15;    // candidates per LLM call
const TIMEOUT_MS   = 180_000; // 3 min per batch (covers cold model-load on first request)

// Confidence thresholds
export const CONFIDENCE = {
  EMAIL:            0.97,
  PHONE:            0.95,
  LEGAL_DESCRIPTION:0.95,
  AMOUNT_SIGN:      0.95,  // $ sign
  ADDRESS:          0.90,
  ALLCAPS_ENTITY:   0.75,
  DATE_LONG:        0.90,
  DATE_ISO:         0.88,
  DATE_ORDINAL:     0.87,
  DATE_SHORT:       0.82,
  AMOUNT_WORD:      0.80,
  ZIP:              0.95,
  MIXED_ENTITY_LONG:0.72,  // mixed-case entity >= 30 chars
  MIXED_ENTITY_MED: 0.60,  // mixed-case entity 15–29 chars
  NER_PERSON:       0.60,
  NER_ORG:          0.50,
  NER_MONEY:        0.85,
};

// Detections at or above this threshold skip the LLM
export const LLM_THRESHOLD = 0.78;

/**
 * Run one batch of up to BATCH_SIZE candidates through the LLM.
 * Returns { approved: Set<number>, prompt, response } relative to the batch slice.
 */
async function runBatch(batch, model) {
  const effectiveModel = model || MODEL;
  const lines = batch.map((c, i) => {
    const ctx = c.context.length > 120
      ? '...' + c.context.slice(-120)
      : c.context;
    return `${i + 1}. [${c.detection.type}] "${c.detection.value}" — "${ctx}"`;
  });

  const prompt =
    `You are reviewing a legal document for redaction.\n` +
    `For each item below, reply Y if it likely identifies a specific private person, company, or party that should be redacted.\n` +
    `Reply N if it is most likely not a private person, company or party.\n` +
    `Reply with ONLY a JSON array of "Y" or "N" in the same order matching exactly the number of items below, NOTHING ELSE.\n` +
    lines.join('\n') + '\n\nReply:';

  // Allow enough tokens for preamble + JSON array; each verdict ~4 tokens + overhead
  const numPredict = Math.max(batch.length * 10, 80);

  console.log(`[LLM] Sending batch of ${batch.length} items to model "${effectiveModel}" (num_predict=${numPredict})`);

  let resp;
  try {
    resp = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: effectiveModel, prompt, stream: false,
        options: { temperature: 0, num_predict: numPredict },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[LLM] Network/timeout error connecting to Ollama:`, err.message);
    throw err;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error(`[LLM] Ollama HTTP ${resp.status}: ${body.slice(0, 200)}`);
    throw new Error(`Ollama HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  const raw  = (data.response || '').trim();

  console.log(`[LLM] Raw response (${raw.length} chars): ${raw.slice(0, 300)}`);

  // Extract first JSON array from the response
  const match = raw.match(/\[[\s\S]*?\]/);
  if (!match) {
    console.error(`[LLM] No JSON array found in response. Full response: ${raw}`);
    throw new Error(`No JSON array in LLM response: ${raw.slice(0, 200)}`);
  }

  let verdicts;
  try {
    verdicts = JSON.parse(match[0]);
  } catch (parseErr) {
    console.error(`[LLM] JSON parse failed on: ${match[0]}`);
    throw new Error(`Invalid JSON from LLM: ${match[0].slice(0, 200)}`);
  }

  console.log(`[LLM] Verdicts: ${JSON.stringify(verdicts)}`);

  if (verdicts.length !== batch.length) {
    console.warn(`[LLM] Expected ${batch.length} verdicts but got ${verdicts.length}`);
  }

  const approved = new Set();
  for (let i = 0; i < batch.length; i++) {
    if (String(verdicts[i] ?? 'Y').toUpperCase().startsWith('Y')) approved.add(i);
  }
  return { approved, prompt, response: raw };
}

/**
 * Ask the LLM which of the supplied candidates should actually be redacted.
 * Processes in batches of BATCH_SIZE to stay within timeout limits.
 *
 * @param {Array<{detection, context}>} candidates
 * @param {Function} onBatch  — called after each batch: (batchNum, totalBatches, approvedCount, rejectedCount)
 * @returns {Promise<{ approved: Set<number>, llmLog: Array }>}
 *   approved — global indices (into candidates) that the LLM approved for redaction
 *   llmLog   — [{prompt, response, items:[{value,type,verdict}]}] one entry per batch
 */
export async function llmFilter(candidates, onBatch = () => {}, model = null) {
  const approved = new Set();
  const llmLog   = [];

  if (!candidates.length) {
    console.log('[LLM] No candidates to filter, skipping LLM phase');
    return { approved, llmLog };
  }

  const totalBatches = Math.ceil(candidates.length / BATCH_SIZE);
  console.log(`[LLM] Starting LLM filter: ${candidates.length} candidates in ${totalBatches} batch(es), model=${model || MODEL + ' (default)'}`);

  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + BATCH_SIZE);
    const batchNum = Math.floor(offset / BATCH_SIZE) + 1;
    try {
      const { approved: batchApproved, prompt, response } = await runBatch(batch, model);

      const items = batch.map((c, i) => ({
        value:   c.detection.value,
        type:    c.detection.type,
        source:  c.detection.source,
        verdict: batchApproved.has(i) ? 'Y' : 'N',
      }));
      llmLog.push({ prompt, response, items });

      batchApproved.forEach(i => approved.add(offset + i));
      console.log(`[LLM] Batch ${batchNum}/${totalBatches} complete: ${batchApproved.size} approved, ${batch.length - batchApproved.size} rejected`);
      onBatch(batchNum, totalBatches, batchApproved.size, batch.length - batchApproved.size);

    } catch (err) {
      console.error(`[LLM] Batch ${batchNum}/${totalBatches} FAILED: ${err.message}`);
      // Fail open for this batch — mark all as approved
      batch.forEach((_, i) => approved.add(offset + i));
      llmLog.push({ prompt: '(failed)', response: err.message, items: [] });
      onBatch(batchNum, totalBatches, batch.length, 0);
    }
  }

  console.log(`[LLM] Filter complete: ${approved.size}/${candidates.length} candidates approved for redaction`);
  return { approved, llmLog };
}
