/**
 * LLM-based second-opinion filter using a local Ollama model.
 * Called only for low-confidence detections to reduce false positives.
 */

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL      = 'llama3.2:3b';

// Confidence thresholds
export const CONFIDENCE = {
  EMAIL:            0.97,
  PHONE:            0.95,
  LEGAL_DESCRIPTION:0.95,
  AMOUNT_SIGN:      0.95,  // $ sign
  ADDRESS:          0.90,
  ALLCAPS_ENTITY:   0.90,
  DATE_LONG:        0.90,
  DATE_ISO:         0.88,
  DATE_ORDINAL:     0.87,
  DATE_SHORT:       0.82,
  AMOUNT_WORD:      0.80,
  ZIP:              0.75,
  MIXED_ENTITY_LONG:0.72,  // mixed-case entity >= 30 chars
  MIXED_ENTITY_MED: 0.60,  // mixed-case entity 15–29 chars
  NER_PERSON:       0.60,
  NER_ORG:          0.50,
  NER_MONEY:        0.85,
};

// Detections at or above this threshold skip the LLM
export const LLM_THRESHOLD = 0.78;

/**
 * Ask the LLM which of the supplied candidates should actually be redacted.
 * @param {Array<{detection, context}>} candidates
 * @returns {Promise<Set<number>>} — indices of candidates the LLM says to redact
 */
export async function llmFilter(candidates) {
  if (!candidates.length) return new Set(candidates.map((_, i) => i));

  const lines = candidates.map((c, i) => {
    const ctx = c.context.length > 120
      ? '...' + c.context.slice(-120)
      : c.context;
    return `${i + 1}. [${c.detection.type}] "${c.detection.value}" — "${ctx}"`;
  });

  const prompt =
    `You are reviewing a legal real-estate document for redaction.\n` +
    `For each item below, reply Y if it identifies a specific private person, company, or party that should be redacted.\n` +
    `Reply N if it is a generic legal term, concept, defined term, place name, or non-sensitive reference.\n` +
    `Reply with ONLY a JSON array of "Y" or "N" in the same order, nothing else.\n\n` +
    lines.join('\n') + '\n\nReply:';

  try {
    const resp = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: false,
        options: { temperature: 0, num_predict: candidates.length * 6 } }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
    const data = await resp.json();
    const raw  = (data.response || '').trim();

    // Extract first JSON array from the response
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) throw new Error('No JSON array in LLM response');
    const verdicts = JSON.parse(match[0]);

    const keep = new Set();
    for (let i = 0; i < candidates.length; i++) {
      if (String(verdicts[i]).toUpperCase().startsWith('Y')) keep.add(i);
    }
    return keep;

  } catch (err) {
    console.warn('LLM filter unavailable, passing all candidates through:', err.message);
    // Fail open — redact everything if LLM is down
    return new Set(candidates.map((_, i) => i));
  }
}
