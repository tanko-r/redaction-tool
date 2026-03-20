// All regex-based detectors. Each returns { type, value, start, end }.

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findAll(text, regex, type) {
  const results = [];
  let m;
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  while ((m = re.exec(text)) !== null) {
    results.push({ type, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return results;
}

// ─── Individual detectors ─────────────────────────────────────────────────────

// Email addresses
const EMAIL = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;

// US phone numbers — covers (206) 628-5623, 206-628-5623, 206.628.5623
const PHONE = /\(?\b\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/g;

// Dollar amounts with $ sign — $86,050,000  $50,000.00  $10.00
const DOLLAR_SIGN = /\$\s*[\d,]+(?:\.\d{2})?/g;

// English word dollar amounts in legal documents:
// "Eighty-Six Million and No/100 Dollars"  "One Hundred Thousand Dollars"
// "Fifty Thousand and No/100"
const NUM_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const SCALE = '(?:hundred|thousand|million|billion)';
const WORD_DOLLAR = new RegExp(
  `\\b${NUM_WORD}(?:[\\s\\-]${NUM_WORD})*(?:\\s+${SCALE}(?:[\\s\\-]${NUM_WORD}(?:[\\s\\-]${NUM_WORD})*(?:\\s+${SCALE})?)*)?(?:\\s+and\\s+(?:no|zero)[-/]\\d+)?(?:\\s+dollars?)?(?=\\s|\\(|$)`,
  'gi'
);

// ─── Suffix-anchored entity detection ─────────────────────────────────────────
// Find a business suffix, then scan backwards collecting words that are
// ALL CAPS or Initial Caps (or numbers or & connectors).
// This replaces the old ALLCAPS_ENTITY and MIXED_CASE_ENTITY patterns and
// handles both "ASB PROPERTY NAME LLC" and "Random Realty Co." naturally.

const BUSINESS_SUFFIXES =
  'LLC|L\\.L\\.C\\.|Corp(?:oration)?|Inc(?:orporated)?|Ltd|LLP|L\\.P\\.|LP' +
  '|Trust|Holdings?|Partners(?:hip)?|Associates?|Company|Co\\.' +
  '|PS|P\\.S\\.|PLC|Group|Foundation|Services|Bank|Fund';

// (?!\w) instead of \b at the end so suffixes ending in "." (Co., L.L.C.) still match
const SUFFIX_RE = new RegExp(
  `(?:,\\s*)?\\b(${BUSINESS_SUFFIXES})(?!\\w)`,
  'gi'
);

// Read one whitespace-delimited token scanning backwards from `pos`.
// Returns { token, tokenStart, newPos } or null if pos < 0.
function readTokenBackward(text, pos) {
  while (pos >= 0 && /[\s,]/.test(text[pos])) pos--;
  if (pos < 0) return null;
  const tokenEnd = pos + 1;
  while (pos >= 0 && !/[\s,]/.test(text[pos])) pos--;
  return { token: text.slice(pos + 1, tokenEnd), tokenStart: pos + 1, newPos: pos };
}

// Scan backwards from `pos`, collecting capitalized name tokens.
// Returns { entityStart, nameWordCount } where entityStart falls back to `fallback`.
function scanBackForName(text, pos, fallback) {
  let entityStart = fallback;
  let nameWordCount = 0;
  let t;

  while ((t = readTokenBackward(text, pos)) !== null) {
    pos = t.newPos;
    const isNameWord = /^[A-Z][A-Za-z0-9'.&-]*$/.test(t.token) || /^[0-9]+$/.test(t.token);
    const isConnector = /^(&amp;|&)$/.test(t.token) && nameWordCount > 0;

    if (isNameWord) { entityStart = t.tokenStart; nameWordCount++; }
    else if (isConnector) { entityStart = t.tokenStart; }
    else break;
  }

  return { entityStart, nameWordCount };
}

function findEntitiesBySuffix(text) {
  const results = [];
  const re = new RegExp(SUFFIX_RE.source, 'gi');
  let sm;

  while ((sm = re.exec(text)) !== null) {
    // Include a trailing period if the suffix doesn't already end with one (e.g. "Inc.")
    let suffixEnd = sm.index + sm[0].length;
    if (text[suffixEnd] === '.') suffixEnd++;

    // Skip whitespace/comma immediately before the suffix word, then scan back
    let pos = sm.index - 1;
    while (pos >= 0 && /[\s,]/.test(text[pos])) pos--;

    const { entityStart, nameWordCount } = scanBackForName(text, pos, sm.index);
    if (nameWordCount === 0) continue;

    // Slice original text to preserve spacing/punctuation exactly
    let value = text.slice(entityStart, suffixEnd).trim();
    // Strip any orphaned connector at the front or back
    value = value.replace(/^(?:&amp;|&)\s*/i, '').replace(/\s*(?:&amp;|&)$/i, '').trim();
    if (value.length < 3) continue;

    const trueStart = text.indexOf(value, entityStart);
    results.push({
      type:  'ORGANIZATION',
      value,
      start: trueStart >= 0 ? trueStart : entityStart,
      end:   suffixEnd,
    });
  }

  // Remove results that are fully contained within a longer result
  return results.filter(r =>
    !results.some(other => other !== r && other.start <= r.start && other.end >= r.end)
  );
}

// Street addresses — number + street name + suffix (+ optional suite/unit)
const STREET_SUFFIXES = 'Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Trail|Terrace|Ter|Plaza|Loop';
const STREET_ADDRESS = new RegExp(
  `\\b\\d{1,6}(?:\\s*-\\s*\\d{1,6})?\\s+[A-Za-z0-9][A-Za-z0-9\\s]+(?:${STREET_SUFFIXES})\\.?(?:\\s+(?:Suite|Ste|#|Apt|Unit|Floor|Fl)\\.?\\s*[A-Za-z0-9]+)?`,
  'g'
);

// P.O. Box addresses
const PO_BOX = /\bP\.?\s*O\.?\s*Box\s+\d+\b/gi;

// US zip codes — 5-digit or ZIP+4, only when preceded by a 2-letter state abbreviation
const ZIP_CODE = /(?<=\b[A-Z]{2}\s)\d{5}(?:-\d{4})?\b/g;

// Dates in common legal document formats
const DATE_LONG    = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/g;
const DATE_SHORT   = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const DATE_ISO     = /\b\d{4}-\d{2}-\d{2}\b/g;
const DATE_ORDINAL = /\b(?:\d{1,2}(?:st|nd|rd|th)\s+day\s+of\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:,\s+\d{4})?)\b/gi;

// Legal property descriptions — trigger phrases; we redact the entire matched text node
const LEGAL_DESC_TRIGGERS = [
  /\bLot\s+\d+[A-Z]?\s*,\s*Block\s+\d+\b/gi,
  /\brecorded\s+in\s+(?:volume|book)\s+\d+\s+of\s+plats?\b/gi,
  /\baccording\s+to\s+the\s+plat\s+thereof\b/gi,
  /\bTax\s+Parcel\s+(?:No\.?|Number|ID)?[\s:]+[\dA-Z\-]+/gi,
  /\bParcel\s+(?:No\.?|Number|ID|#)[\s:]*[\dA-Z\-]+/gi,
  /\bAssessor'?s?\s+Parcel\s+(?:No\.?|Number)[\s:]+[\dA-Z\-]+/gi,
  /\bBeginning\s+at\s+(?:the|a)\s+\b/gi,
  /\bThence\s+(?:North|South|East|West|N|S|E|W)/gi,
];

// ─── Public API ───────────────────────────────────────────────────────────────

import { CONFIDENCE } from './llm.js';

export function runRegexDetectors(text) {
  const results = [];

  const tag = (hits, confidence, source) =>
    hits.forEach(h => results.push({ ...h, confidence, source }));

  tag(findAll(text, EMAIL,        'EMAIL'),  CONFIDENCE.EMAIL,       'regex');
  tag(findAll(text, PHONE,        'PHONE'),  CONFIDENCE.PHONE,       'regex');
  tag(findAll(text, DOLLAR_SIGN,  'AMOUNT'), CONFIDENCE.AMOUNT_SIGN, 'regex');
  tag(findAll(text, STREET_ADDRESS,'ADDRESS'),CONFIDENCE.ADDRESS,    'regex');
  tag(findAll(text, PO_BOX,       'ADDRESS'),CONFIDENCE.ADDRESS,     'regex');
  tag(findAll(text, ZIP_CODE,     'ZIP'),    CONFIDENCE.ZIP,         'regex');
  tag(findAll(text, DATE_LONG,    'DATE'),   CONFIDENCE.DATE_LONG,   'regex');
  tag(findAll(text, DATE_SHORT,   'DATE'),   CONFIDENCE.DATE_SHORT,  'regex');
  tag(findAll(text, DATE_ISO,     'DATE'),   CONFIDENCE.DATE_ISO,    'regex');
  tag(findAll(text, DATE_ORDINAL, 'DATE'),   CONFIDENCE.DATE_ORDINAL,'regex');

  // Suffix-anchored entity scan — replaces old ALLCAPS_ENTITY + MIXED_CASE_ENTITY
  for (const m of findEntitiesBySuffix(text)) {
    results.push({ ...m, confidence: CONFIDENCE.ALLCAPS_ENTITY, source: 'suffix' });
  }

  // English word dollar amounts — only if contains a scale word
  const scaleRe = /\b(?:hundred|thousand|million|billion|dollars?)\b/i;
  for (const m of findAll(text, WORD_DOLLAR, 'AMOUNT')) {
    if (scaleRe.test(m.value)) results.push({ ...m, confidence: CONFIDENCE.AMOUNT_WORD, source: 'regex' });
  }

  // Legal description triggers — flag the whole text node via a sentinel
  for (const re of LEGAL_DESC_TRIGGERS) {
    if (findAll(text, re, 'LEGAL_DESCRIPTION').length) {
      results.push({ type: 'LEGAL_DESCRIPTION', value: text, start: 0, end: text.length,
        confidence: CONFIDENCE.LEGAL_DESCRIPTION, source: 'regex' });
      break;
    }
  }

  // Word-count cap: drop non-exempt detections longer than 10 words
  const EXEMPT = new Set(['EMAIL', 'PHONE', 'AMOUNT', 'ADDRESS', 'ZIP', 'LEGAL_DESCRIPTION']);
  return results.filter(d => EXEMPT.has(d.type) || d.value.trim().split(/\s+/).length <= 10);
}
