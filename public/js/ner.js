// Browser-based NER using Transformers.js — replaces the Python spaCy subprocess.
// Uses Xenova/bert-base-NER for token classification.

let nerPipeline = null;
let loadingPromise = null;

// Blocklists ported from ner.py
const PERSON_BLOCKLIST = new Set([
  'seller', 'purchaser', 'buyer', 'agent', 'broker', 'escrow', 'closing',
  'party', 'parties', 'grantor', 'grantee', 'trustee', 'beneficiary',
  'witness', 'notary', 'officer', 'manager', 'member', 'owner', 'tenant',
  'landlord', 'lessee', 'lessor', 'assignee', 'assignor', 'guarantor',
  'representative', 'attorney', 'counsel', 'principal', 'director',
  'president', 'secretary', 'treasurer', 'signatory', 'executor',
  'administrator', 'heir', 'devisee', 'mortgagor', 'mortgagee',
]);

const ORG_BLOCKLIST = new Set([
  'seller', 'purchaser', 'buyer', 'agent', 'broker', 'escrow', 'party',
  'parties', 'grantor', 'grantee', 'trustee', 'beneficiary', 'guarantor',
  'assignee', 'assignor', 'lessor', 'lessee', 'landlord', 'tenant',
  'representative', 'attorney', 'counsel', 'manager', 'member', 'owner',
  'title company', 'escrow agent', 'title insurance', 'escrow company',
  'earnest money', 'real estate', 'the company', 'limited liability company',
  'limited partnership', 'general partnership', 'title officer',
  'title review', 'title commitment', 'title policy', 'title report',
]);

const ORG_BUSINESS_SUFFIXES = new Set([
  'corporation', 'corp', 'inc', 'incorporated', 'llc', 'l.l.c.', 'ltd',
  'lp', 'llp', 'l.p.', 'company', 'co', 'trust', 'foundation',
  'partners', 'partnership', 'associates', 'group', 'holdings',
  'authority', 'association', 'institute', 'bank', 'fund',
  'ps', 'p.s.', 'plc', 'services', 'solutions',
]);

const ORG_TERM_ENDINGS = new Set([
  'date', 'period', 'deadline', 'notice', 'condition', 'obligation',
  'event', 'right', 'option', 'requirement', 'schedule', 'threshold',
  'price', 'cost', 'fee', 'term', 'terms', 'approval', 'consent',
  'extension', 'expiration', 'commencement', 'termination', 'closing',
  'subdivision', 'development', 'review', 'affidavit', 'warranty',
  'representation', 'proceedings', 'covenant', 'restriction', 'easement',
  'amendment', 'modification', 'entitlement', 'agreement', 'section',
  'plan', 'report', 'permit', 'certificate', 'policy', 'commitment',
  'money', 'funds', 'proceeds', 'deposit', 'time', 'zone',
  'conditions', 'provisions', 'obligations', 'rights', 'interests',
  'owner', 'owners',
]);

const LEADING_NON_ORG_WORDS = new Set([
  'the', 'a', 'an', 'all', 'any', 'each', 'every', 'such',
  'no', 'this', 'that', 'these', 'those', 'its', 'their',
  'our', 'your', 'said', 'certain', 'other', 'either',
]);

const LEADING_VERB_BLOCKLIST = new Set([
  'pursue', 'execute', 'deliver', 'provide', 'obtain', 'complete',
  'satisfy', 'perform', 'pay', 'give', 'make', 'take', 'use', 'apply',
  'require', 'notify', 'approve', 'consent', 'waive', 'terminate',
  'commence', 'extend', 'exercise', 'close', 'conduct', 'prepare',
]);

/**
 * Load the NER model. Call once; subsequent calls return cached pipeline.
 * @param {Function} onProgress — (progress) => void, for download tracking
 */
export async function loadNER(onProgress = () => {}) {
  if (nerPipeline) return nerPipeline;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm');
    // Use WASM backend for maximum compatibility
    env.backends.onnx.wasm.proxy = false;
    nerPipeline = await pipeline('token-classification', 'Xenova/bert-base-NER', {
      progress_callback: onProgress,
      dtype: 'q8',  // quantized for speed
    });
    return nerPipeline;
  })();

  return loadingPromise;
}

export function isNERLoaded() {
  return nerPipeline !== null;
}

/**
 * Run NER on a single text string. Returns array of {type, value, start, end}.
 * Applies the same blocklist filtering as the Python ner.py.
 */
export async function runNER(text) {
  if (!nerPipeline) throw new Error('NER model not loaded. Call loadNER() first.');

  const raw = await nerPipeline(text, { aggregation_strategy: 'simple' });

  const entities = [];
  for (const ent of raw) {
    const label = ent.entity_group; // PER, ORG, LOC, MISC
    const value = text.slice(ent.start, ent.end).trim();
    const lower = value.toLowerCase();

    if (label === 'PER') {
      const words = value.split(/\s+/);
      if (words.length < 2) continue;
      const cleanLower = lower.replace(/[''\u2019]s/g, '').trim();
      if (PERSON_BLOCKLIST.has(cleanLower)) continue;
      if (words.some(w => PERSON_BLOCKLIST.has(w.toLowerCase().replace(/[''\u2019s.,;]+$/g, '')))) continue;
      entities.push({ type: 'PERSON', value, start: ent.start, end: ent.end });
    }
    else if (label === 'ORG') {
      if (ORG_BLOCKLIST.has(lower)) continue;
      const words = value.split(/\s+/);
      const lastWord = words[words.length - 1].toLowerCase().replace(/[.,;]+$/, '');
      const firstWord = words[0].toLowerCase();
      if (words.length < 2 && !ORG_BUSINESS_SUFFIXES.has(lastWord)) continue;
      if (LEADING_NON_ORG_WORDS.has(firstWord) && !ORG_BUSINESS_SUFFIXES.has(lastWord)) continue;
      if (LEADING_VERB_BLOCKLIST.has(firstWord)) continue;
      if (PERSON_BLOCKLIST.has(firstWord.replace(/[''\u2019]s/g, '')) && !ORG_BUSINESS_SUFFIXES.has(lastWord)) continue;
      if (ORG_TERM_ENDINGS.has(lastWord)) continue;
      entities.push({ type: 'ORG', value, start: ent.start, end: ent.end });
    }
    else if (label === 'MISC' && /\$|dollar|money/i.test(value)) {
      entities.push({ type: 'MONEY', value, start: ent.start, end: ent.end });
    }
  }

  return entities;
}

/**
 * Run NER on multiple texts. Returns array of entity arrays (one per text).
 */
export async function runNERBatch(texts) {
  const results = [];
  for (const text of texts) {
    try {
      results.push(await runNER(text));
    } catch {
      results.push([]);
    }
  }
  return results;
}
