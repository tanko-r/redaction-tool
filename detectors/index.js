import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { runRegexDetectors } from './regex.js';
import { llmFilter, CONFIDENCE, LLM_THRESHOLD } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NER_SCRIPT = path.join(__dirname, 'ner.py');

// ─── Persistent NER subprocess ────────────────────────────────────────────────

let nerProc = null;
let nerReady = false;
let lineBuffer = '';
const pendingQueue = [];

function startNER() {
  nerProc = spawn('python3', [NER_SCRIPT]);

  nerProc.stdout.on('data', (chunk) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // keep partial line
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.ready) { nerReady = true; continue; }

      const next = pendingQueue.shift();
      if (next) {
        if (msg.error) next.reject(new Error(msg.error));
        else next.resolve(msg);
      }
    }
  });

  nerProc.stderr.on('data', () => {}); // suppress spaCy startup noise
  nerProc.on('exit', () => { nerProc = null; nerReady = false; });
}

function nerDetect(texts) {
  if (!nerProc) startNER();

  return new Promise((resolve, reject) => {
    const doSend = () => {
      pendingQueue.push({ resolve, reject });
      nerProc.stdin.write(JSON.stringify(texts) + '\n');
    };

    if (nerReady) {
      doSend();
    } else {
      // Wait for ready signal (usually < 2s)
      const poll = setInterval(() => {
        if (nerReady) { clearInterval(poll); doSend(); }
      }, 50);
    }
  });
}

// ─── Term normalisation ───────────────────────────────────────────────────────
// Strip leading articles so "the Effective Date" matches defined term "Effective Date"
function normalizeTerm(s) {
  return s.toLowerCase()
    .replace(/^(?:the|a|an|all|any|each|every|such|this|that|these|those|its|their|said)\s+/, '')
    .trim();
}

// ─── Defined-terms extraction ─────────────────────────────────────────────────
// Collects every quoted phrase (" " or curly " ") in the document as a
// defined term that should never be redacted.

const QUOTE_RE = /["\u201C]([^"\u201D\n]{1,80})["\u201D]/g;

export function extractDefinedTerms(xmlTexts) {
  const terms = new Set();
  const combined = xmlTexts.join(' ');
  let m;
  while ((m = QUOTE_RE.exec(combined)) !== null) {
    const term = m[1].trim();
    if (term.length >= 2) terms.add(normalizeTerm(term));
  }
  return terms;
}

// ─── Merge & apply ────────────────────────────────────────────────────────────

function mergeDetections(regexHits, nerHits) {
  const all = [...regexHits, ...nerHits].sort((a, b) => a.start - b.start);
  // Remove overlaps — keep whichever starts first (regex wins ties with NER
  // because we push regex first and sort is stable in V8)
  const merged = [];
  for (const d of all) {
    if (!merged.length || d.start >= merged.at(-1).end) {
      merged.push(d);
    }
  }
  return merged;
}

function applyRedactions(text, detections, definedTerms, userWhitelist = new Set()) {
  // Filter out defined terms, user-whitelisted values, and LLM-rejected detections
  const active = detections.filter(d =>
    d.approved !== false &&
    !definedTerms.has(normalizeTerm(d.value)) &&
    !userWhitelist.has(d.value.toLowerCase())
  );

  // Re-sort after filtering (order may have changed if we removed entries)
  active.sort((a, b) => a.start - b.start);

  let out = '';
  let pos = 0;
  for (const d of active) {
    out += text.slice(pos, d.start);
    out += `[${d.type}]`;
    pos = d.end;
  }
  return out + text.slice(pos);
}

// ─── Value propagation ────────────────────────────────────────────────────────

// Find all non-overlapping occurrences of `lcValue` in `text` not already covered.
function findNewOccurrences(text, existing, lcValue, meta) {
  const lcText = text.toLowerCase();
  const additions = [];
  let searchPos = 0;
  while (true) {
    const found = lcText.indexOf(lcValue, searchPos);
    if (found === -1) break;
    const end = found + lcValue.length;
    if (!existing.some(d => d.start < end && d.end > found)) {
      additions.push({ type: meta.type, value: text.slice(found, end), start: found, end,
        confidence: meta.confidence, source: 'propagated' });
    }
    searchPos = found + 1;
  }
  return additions;
}

// Given a Map of lc-value → {type, confidence, source}, scan all text nodes and
// inject detections for any occurrence not already covered.
function propagateValues(texts, allMerged, valueMap, definedTerms, userWhitelist) {
  if (valueMap.size === 0) return 0;
  let added = 0;
  texts.forEach((text, i) => {
    const existing = allMerged[i];
    for (const [lcValue, meta] of valueMap) {
      if (definedTerms.has(normalizeTerm(lcValue)) || userWhitelist.has(lcValue)) continue;
      const newOnes = findNewOccurrences(text, existing, lcValue, meta);
      newOnes.forEach(d => { existing.push(d); added++; });
    }
    // Re-sort and de-overlap after additions
    existing.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const d of existing) {
      if (!merged.length || d.start >= merged.at(-1).end) merged.push(d);
    }
    allMerged[i] = merged;
  });
  return added;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Redact an array of text strings.
 * @param {string[]} texts        — All <w:t> content strings from the document
 * @param {Set}      definedTerms — Terms extracted from quoted phrases in the doc
 * @param {Set}      userWhitelist — User-supplied terms to preserve (lowercased)
 * @param {Function} progress  — callback({ msg, pct }) for status updates
 * @param {string|null} model — Ollama model override (null = use default)
 * @returns {Promise<{ redacted: string[], llmLog: Array, changedNodes: Array }>}
 */
export async function redactTexts(texts, definedTerms, userWhitelist = new Set(), progress = () => {}, model = null) {
  // Filter to segments worth sending to NER (skip blanks and very short strings)
  const NER_MIN_LENGTH = 4;
  const nerIndices = [];
  const nerTexts = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].trim().length >= NER_MIN_LENGTH) {
      nerIndices.push(i);
      nerTexts.push(texts[i]);
    }
  }

  progress({ msg: `Running regex detectors on ${texts.length} node(s)...`, pct: 20 });

  // Run NER on qualifying texts
  progress({ msg: `Running NLP analysis on ${nerTexts.length} qualifying node(s)...`, pct: 30 });
  let nerResults = nerTexts.map(() => []); // default empty
  if (nerTexts.length > 0) {
    try {
      const raw = await nerDetect(nerTexts);
      if (Array.isArray(raw)) nerResults = raw;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('NER error:', e.message);
    }
  }

  // Build per-index NER map, tagging NER results with confidence + source
  // Apply word-count cap here at the NER stage (MONEY exempt, same as AMOUNT)
  const MAX_WORDS = 10;
  const NER_WORDCOUNT_EXEMPT = new Set(['MONEY']);
  const nerByIndex = new Map();
  for (let j = 0; j < nerIndices.length; j++) {
    const tagged = (nerResults[j] || [])
      .filter(d => NER_WORDCOUNT_EXEMPT.has(d.type) || d.value.trim().split(/\s+/).length <= MAX_WORDS)
      .map(d => ({
        ...d,
        confidence: d.type === 'PERSON' ? CONFIDENCE.NER_PERSON
                  : d.type === 'ORG'    ? CONFIDENCE.NER_ORG
                  :                       CONFIDENCE.NER_MONEY,
        source: 'ner',
      }));
    nerByIndex.set(nerIndices[j], tagged);
  }

  // Types exempt from the word-count cap (addresses, amounts, legal descriptions span many words)
  const WORDCOUNT_EXEMPT = new Set(['ADDRESS', 'AMOUNT', 'LEGAL_DESCRIPTION', 'ZIP']);

  // Build merged detections per text segment
  let regexTotal = 0, nerTotal = 0, filteredTotal = 0;
  const allMerged = texts.map((text, i) => {
    const regex = runRegexDetectors(text);
    const ner   = nerByIndex.get(i) || [];
    regexTotal += regex.length;
    nerTotal   += ner.length;
    const merged = mergeDetections(regex, ner);
    // Drop any detection longer than MAX_WORDS unless it's an exempt type
    const filtered = merged.filter(d =>
      WORDCOUNT_EXEMPT.has(d.type) || d.value.trim().split(/\s+/).length <= MAX_WORDS
    );
    filteredTotal += filtered.length;
    return filtered;
  });
  progress({ msg: `Regex: ${regexTotal} hit(s) · NLP: ${nerTotal} hit(s) · ${filteredTotal} candidate(s) after word-count filter`, pct: 55 });

  // Phase A: propagate high-confidence values (>= LLM_THRESHOLD) to all nodes before LLM.
  // This both catches missed occurrences and reduces the LLM candidate pool.
  const highConfMap = new Map();
  allMerged.forEach(detections => {
    detections.forEach(d => {
      if ((d.confidence ?? 1) >= LLM_THRESHOLD) {
        const key = d.value.toLowerCase();
        if (!highConfMap.has(key))
          highConfMap.set(key, { type: d.type, confidence: d.confidence ?? 1, source: d.source });
      }
    });
  });
  const propAdded = propagateValues(texts, allMerged, highConfMap, definedTerms, userWhitelist);
  if (propAdded > 0)
    progress({ msg: `Propagated ${highConfMap.size} high-confidence value(s) → ${propAdded} additional detection(s)`, pct: 57 });

  // Collect low-confidence candidates (not already filtered by defined terms / whitelist)
  // and send them to the LLM in one batch call
  const llmCandidates = []; // { textIndex, detectionIndex, detection, context }
  allMerged.forEach((detections, ti) => {
    detections.forEach((d, di) => {
      if ((d.confidence ?? 1) < LLM_THRESHOLD &&
          !definedTerms.has(normalizeTerm(d.value)) &&
          !userWhitelist.has(d.value.toLowerCase())) {
        llmCandidates.push({ textIndex: ti, detectionIndex: di, detection: d, context: texts[ti] });
      }
    });
  });

  let llmLog = [];
  if (llmCandidates.length > 0) {
    // Deduplicate by lowercased value — send each unique entity value once to the LLM,
    // then fan the verdict back to all candidates sharing that value.
    const valueToIndices = new Map(); // lc value → [candidate indices]
    llmCandidates.forEach((c, idx) => {
      const key = c.detection.value.toLowerCase();
      if (!valueToIndices.has(key)) valueToIndices.set(key, []);
      valueToIndices.get(key).push(idx);
    });

    // One representative candidate per unique value
    const uniqueCandidates = [];
    const uniqueKeys = [];
    for (const [key, indices] of valueToIndices) {
      uniqueCandidates.push(llmCandidates[indices[0]]);
      uniqueKeys.push(key);
    }

    const totalBatches = Math.ceil(uniqueCandidates.length / 20);
    progress({ msg: `LLM reviewing ${uniqueCandidates.length} unique value(s) (${llmCandidates.length} total candidate(s)) in ${totalBatches} batch(es)...`, pct: 60 });
    const { approved: approvedUnique, llmLog: log } = await llmFilter(uniqueCandidates, (batchNum, batchTotal, approved, rejected) => {
      const pct = 60 + Math.round((batchNum / batchTotal) * 30);
      progress({ msg: `LLM batch ${batchNum}/${batchTotal} complete — ${approved} approved, ${rejected} rejected`, pct });
    }, model);
    llmLog = log;

    // Build a set of rejected value keys, then mark all candidates sharing that value
    const rejectedKeys = new Set();
    uniqueKeys.forEach((key, i) => {
      if (!approvedUnique.has(i)) rejectedKeys.add(key);
    });

    llmCandidates.forEach((c) => {
      if (rejectedKeys.has(c.detection.value.toLowerCase())) {
        allMerged[c.textIndex][c.detectionIndex].approved = false;
      }
    });

    // Phase B: propagate LLM-approved values to catch remaining occurrences in other nodes
    const llmApprovedMap = new Map();
    uniqueKeys.forEach((key, i) => {
      if (approvedUnique.has(i)) {
        const c = uniqueCandidates[i];
        if (!llmApprovedMap.has(key))
          llmApprovedMap.set(key, { type: c.detection.type, confidence: 0.85, source: 'propagated' });
      }
    });
    const llmPropAdded = propagateValues(texts, allMerged, llmApprovedMap, definedTerms, userWhitelist);
    if (llmPropAdded > 0)
      progress({ msg: `Propagated ${llmApprovedMap.size} LLM-approved value(s) → ${llmPropAdded} additional detection(s)`, pct: 92 });
  }

  // Build changedNodes with traceability: source, confidence, llm verdict
  const changedNodes = [];
  const redacted = allMerged.map((detections, i) => {
    const result = applyRedactions(texts[i], detections, definedTerms, userWhitelist);
    if (result !== texts[i]) {
      // Attach per-detection trace info to the node
      const active = detections.filter(d =>
        d.approved !== false &&
        !definedTerms.has(normalizeTerm(d.value)) &&
        !userWhitelist.has(d.value.toLowerCase())
      );
      changedNodes.push({
        original:   texts[i],
        redacted:   result,
        detections: active.map(d => ({
          value:      d.value,
          type:       d.type,
          source:     d.source || 'regex',
          confidence: d.confidence ?? 1,
          llmVerdict: d.approved === false ? 'N'
                    : (d.confidence ?? 1) < LLM_THRESHOLD ? 'Y'
                    : null,
        })),
      });
    }
    return result;
  });

  return { redacted, llmLog, changedNodes };
}

// Start NER process eagerly on import so it's warm by the time requests arrive
startNER();
