// Browser-based document redaction engine.
// Ports server.js + detectors/index.js for fully client-side processing.

import { runRegexDetectors } from './regex-detectors.js';
import { runNERBatch, isNERLoaded } from './ner.js';
import { llmFilter, isLLMReady } from './llm.js';
import {
  CONFIDENCE, LLM_THRESHOLD, MAX_WORDS,
  WORDCOUNT_EXEMPT, NER_WORDCOUNT_EXEMPT, NER_MIN_LENGTH,
} from './constants.js';

// ── XML helpers (same as server.js) ─────────────────────────────────────────

const TEXT_PART_RE = [
  /^word\/document\.xml$/,
  /^word\/header\d*\.xml$/,
  /^word\/footer\d*\.xml$/,
  /^word\/footnotes\.xml$/,
  /^word\/endnotes\.xml$/,
  /^word\/comments\.xml$/,
];

function isTextPart(filename) {
  return TEXT_PART_RE.some(r => r.test(filename));
}

function parseTextNodes(xml) {
  const nodes = [];
  const re = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    nodes.push({
      open:    m[1],
      text:    m[2],
      close:   m[3],
      xmlStart: m.index,
      xmlLen:  m[0].length,
    });
  }
  return nodes;
}

function rebuildXml(xml, nodes, redactedTexts) {
  let out = '';
  let pos = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    out += xml.slice(pos, n.xmlStart);
    out += n.open + redactedTexts[i] + n.close;
    pos = n.xmlStart + n.xmlLen;
  }
  return out + xml.slice(pos);
}

// ── Defined terms ───────────────────────────────────────────────────────────

const QUOTE_RE = /["\u201C]([^"\u201D\n]{1,80})["\u201D]/g;

function normalizeTerm(s) {
  return s.toLowerCase()
    .replace(/^(?:the|a|an|all|any|each|every|such|this|that|these|those|its|their|said)\s+/, '')
    .trim();
}

export function extractDefinedTerms(xmlTexts) {
  const terms = new Set();
  const combined = xmlTexts.join(' ');
  let m;
  const re = new RegExp(QUOTE_RE.source, QUOTE_RE.flags);
  while ((m = re.exec(combined)) !== null) {
    const term = m[1].trim();
    if (term.length >= 2) terms.add(normalizeTerm(term));
  }
  return terms;
}

// ── Detection pipeline ──────────────────────────────────────────────────────

function mergeDetections(regexHits, nerHits) {
  const all = [...regexHits, ...nerHits].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const d of all) {
    if (!merged.length || d.start >= merged.at(-1).end) {
      merged.push(d);
    }
  }
  return merged;
}

function applyRedactions(text, detections, definedTerms, userWhitelist = new Set()) {
  const active = detections.filter(d =>
    d.approved !== false &&
    !definedTerms.has(normalizeTerm(d.value)) &&
    !userWhitelist.has(d.value.toLowerCase())
  );
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
    existing.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const d of existing) {
      if (!merged.length || d.start >= merged.at(-1).end) merged.push(d);
    }
    allMerged[i] = merged;
  });
  return added;
}

function buildNerByIndex(nerIndices, nerResults) {
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
  return nerByIndex;
}

function buildMergedDetections(texts, nerByIndex) {
  let regexTotal = 0, nerTotal = 0, filteredTotal = 0;
  const allMerged = texts.map((text, i) => {
    const regex = runRegexDetectors(text);
    const ner   = nerByIndex.get(i) || [];
    regexTotal += regex.length;
    nerTotal   += ner.length;
    const filtered = mergeDetections(regex, ner).filter(d =>
      WORDCOUNT_EXEMPT.has(d.type) || d.value.trim().split(/\s+/).length <= MAX_WORDS
    );
    filteredTotal += filtered.length;
    return filtered;
  });
  return { allMerged, regexTotal, nerTotal, filteredTotal };
}

function buildHighConfMap(allMerged) {
  const map = new Map();
  allMerged.forEach(detections => {
    detections.forEach(d => {
      if ((d.confidence ?? 1) >= LLM_THRESHOLD) {
        const key = d.value.toLowerCase();
        if (!map.has(key))
          map.set(key, { type: d.type, confidence: d.confidence ?? 1, source: d.source });
      }
    });
  });
  return map;
}

function isLLMWorthy(value) {
  const v = value.trim();
  if (v.length < 3) return false;
  if (!/[A-Z]/.test(v)) return false;
  if (/^[a-z]/.test(v)) return false;
  return true;
}

function collectLLMCandidates(texts, allMerged, definedTerms, userWhitelist) {
  const candidates = [];
  allMerged.forEach((detections, ti) => {
    detections.forEach((d, di) => {
      if ((d.confidence ?? 1) < LLM_THRESHOLD &&
          !definedTerms.has(normalizeTerm(d.value)) &&
          !userWhitelist.has(d.value.toLowerCase()) &&
          isLLMWorthy(d.value)) {
        candidates.push({ textIndex: ti, detectionIndex: di, detection: d, context: texts[ti] });
      }
    });
  });
  return candidates;
}

function buildChangedNodes(texts, allMerged, definedTerms, userWhitelist) {
  const changedNodes = [];
  const redacted = allMerged.map((detections, i) => {
    const result = applyRedactions(texts[i], detections, definedTerms, userWhitelist);
    if (result !== texts[i]) {
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
  return { redacted, changedNodes };
}

async function runLLMPhase(texts, allMerged, llmCandidates, definedTerms, userWhitelist, progress, ollamaModel) {
  if (llmCandidates.length === 0) return [];

  const valueToIndices = new Map();
  llmCandidates.forEach((c, idx) => {
    const key = c.detection.value.toLowerCase();
    if (!valueToIndices.has(key)) valueToIndices.set(key, []);
    valueToIndices.get(key).push(idx);
  });

  const uniqueCandidates = [];
  const uniqueKeys = [];
  for (const [key, indices] of valueToIndices) {
    uniqueCandidates.push(llmCandidates[indices[0]]);
    uniqueKeys.push(key);
  }

  const totalBatches = Math.ceil(uniqueCandidates.length / 20);
  progress({ msg: `LLM reviewing ${uniqueCandidates.length} unique value(s) in ${totalBatches} batch(es)...`, pct: 60 });
  const { approved: approvedUnique, llmLog } = await llmFilter(uniqueCandidates, (batchNum, batchTotal, approved, rejected) => {
    const pct = 60 + Math.round((batchNum / batchTotal) * 30);
    progress({ msg: `LLM batch ${batchNum}/${batchTotal} — ${approved} approved, ${rejected} rejected`, pct });
  }, ollamaModel);

  const rejectedKeys = new Set();
  uniqueKeys.forEach((key, i) => { if (!approvedUnique.has(i)) rejectedKeys.add(key); });
  llmCandidates.forEach(c => {
    if (rejectedKeys.has(c.detection.value.toLowerCase()))
      allMerged[c.textIndex][c.detectionIndex].approved = false;
  });

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

  return llmLog;
}

// ── Main pipeline ───────────────────────────────────────────────────────────

async function redactTexts(texts, definedTerms, userWhitelist = new Set(), progress = () => {}, ollamaModel = null) {
  const nerIndices = [];
  const nerTexts = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].trim().length >= NER_MIN_LENGTH) {
      nerIndices.push(i);
      nerTexts.push(texts[i]);
    }
  }

  progress({ msg: `Running regex detectors on ${texts.length} node(s)...`, pct: 20 });

  // Run NER if model is loaded
  let nerResults;
  if (isNERLoaded()) {
    progress({ msg: `Running NLP analysis on ${nerTexts.length} qualifying node(s)...`, pct: 30 });
    nerResults = await runNERBatch(nerTexts);
  } else {
    progress({ msg: `NER model not loaded — skipping NLP analysis`, pct: 30 });
    nerResults = nerTexts.map(() => []);
  }

  const nerByIndex = buildNerByIndex(nerIndices, nerResults);
  const { allMerged, regexTotal, nerTotal, filteredTotal } = buildMergedDetections(texts, nerByIndex);
  progress({ msg: `Regex: ${regexTotal} · NLP: ${nerTotal} · ${filteredTotal} candidate(s) after filtering`, pct: 55 });

  const highConfMap = buildHighConfMap(allMerged);
  const propAdded = propagateValues(texts, allMerged, highConfMap, definedTerms, userWhitelist);
  if (propAdded > 0)
    progress({ msg: `Propagated ${highConfMap.size} high-confidence value(s) → ${propAdded} additional detection(s)`, pct: 57 });

  const llmCandidates = collectLLMCandidates(texts, allMerged, definedTerms, userWhitelist);

  let llmLog = [];
  if (isLLMReady() && llmCandidates.length > 0) {
    llmLog = await runLLMPhase(texts, allMerged, llmCandidates, definedTerms, userWhitelist, progress, ollamaModel);
  } else if (llmCandidates.length > 0) {
    progress({ msg: `No LLM backend — approving ${llmCandidates.length} low-confidence candidate(s) by default`, pct: 60 });
  }

  const { redacted, changedNodes } = buildChangedNodes(texts, allMerged, definedTerms, userWhitelist);
  return { redacted, llmLog, changedNodes };
}

// ── DOCX processing ─────────────────────────────────────────────────────────

/**
 * Redact a DOCX file entirely in the browser.
 * @param {ArrayBuffer} buffer — raw DOCX file bytes
 * @param {Set} userWhitelist
 * @param {Function} progress — ({msg, pct}) => void
 * @param {string|null} ollamaModel
 * @returns {Promise<{buffer: Uint8Array, redactedNodeCount, definedTermCount, changedNodes, llmLog}>}
 */
export async function redactDocx(buffer, userWhitelist = new Set(), progress = () => {}, ollamaModel = null) {
  const JSZip = (await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')).default;
  const zip = await JSZip.loadAsync(buffer);

  const parts = [];
  for (const [filename, file] of Object.entries(zip.files)) {
    if (!file.dir && isTextPart(filename)) {
      const xml = await file.async('string');
      const nodes = parseTextNodes(xml);
      parts.push({ filename, xml, nodes });
    }
  }

  const allTexts = parts.flatMap(p => p.nodes.map(n => n.text));
  progress({ msg: `Found ${allTexts.length} text nodes across ${parts.length} document part(s)`, pct: 15 });

  const definedTerms = extractDefinedTerms(allTexts);
  progress({ msg: `Extracted ${definedTerms.size} defined term(s) to preserve`, pct: 18 });

  const { redacted, llmLog, changedNodes } = await redactTexts(allTexts, definedTerms, userWhitelist, progress, ollamaModel);

  progress({ msg: 'Rebuilding document...', pct: 93 });
  let offset = 0;
  for (const part of parts) {
    const count = part.nodes.length;
    const partRedacted = redacted.slice(offset, offset + count);
    offset += count;
    const newXml = rebuildXml(part.xml, part.nodes, partRedacted);
    zip.file(part.filename, newXml);
  }

  const outputBuffer = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return {
    buffer: outputBuffer,
    redactedNodeCount: changedNodes.length,
    definedTermCount: definedTerms.size,
    changedNodes,
    llmLog,
  };
}
