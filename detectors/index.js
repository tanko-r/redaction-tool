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

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Redact an array of text strings.
 * @param {string[]} texts        — All <w:t> content strings from the document
 * @param {Set}      definedTerms — Terms extracted from quoted phrases in the doc
 * @param {Set}      userWhitelist — User-supplied terms to preserve (lowercased)
 * @returns {Promise<string[]>} — Redacted versions of each string
 */
export async function redactTexts(texts, definedTerms, userWhitelist = new Set()) {
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

  // Run NER on qualifying texts
  let nerResults = nerTexts.map(() => []); // default empty
  if (nerTexts.length > 0) {
    try {
      const raw = await nerDetect(nerTexts);
      if (Array.isArray(raw)) nerResults = raw;
    } catch (e) {
      console.error('NER error:', e.message);
    }
  }

  // Build per-index NER map, tagging NER results with confidence + source
  const nerByIndex = new Map();
  for (let j = 0; j < nerIndices.length; j++) {
    const tagged = (nerResults[j] || []).map(d => ({
      ...d,
      confidence: d.type === 'PERSON' ? CONFIDENCE.NER_PERSON
                : d.type === 'ORG'    ? CONFIDENCE.NER_ORG
                :                       CONFIDENCE.NER_MONEY,
      source: 'ner',
    }));
    nerByIndex.set(nerIndices[j], tagged);
  }

  // Build merged detections per text segment
  const allMerged = texts.map((text, i) => {
    const regex = runRegexDetectors(text);
    const ner   = nerByIndex.get(i) || [];
    return mergeDetections(regex, ner);
  });

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

  if (llmCandidates.length > 0) {
    console.log(`LLM reviewing ${llmCandidates.length} low-confidence detection(s)...`);
    const approved = await llmFilter(llmCandidates);
    llmCandidates.forEach((c, idx) => {
      if (!approved.has(idx)) {
        allMerged[c.textIndex][c.detectionIndex].approved = false;
      }
    });
  }

  return allMerged.map((detections, i) =>
    applyRedactions(texts[i], detections, definedTerms, userWhitelist)
  );
}

// Start NER process eagerly on import so it's warm by the time requests arrive
startNER();
