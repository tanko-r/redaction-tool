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

function findEntitiesBySuffix(text) {
  const results = [];
  const re = new RegExp(SUFFIX_RE.source, 'gi');
  let sm;

  while ((sm = re.exec(text)) !== null) {
    // Include a trailing period if the suffix doesn't already end with one (e.g. "Inc.")
    let suffixEnd = sm.index + sm[0].length;
    if (text[suffixEnd] === '.') suffixEnd++;
    // Start scanning backwards from the character before the match
    // (the optional leading comma/space is part of sm[0] but not the name)
    let pos = sm.index - 1;

    // Skip any whitespace or comma immediately before the suffix word
    while (pos >= 0 && /[\s,]/.test(text[pos])) pos--;

    let entityStart   = sm.index;
    let nameWordCount = 0;

    while (pos >= 0) {
      // Skip whitespace/commas between tokens
      while (pos >= 0 && /[\s,]/.test(text[pos])) pos--;
      if (pos < 0) break;

      // Scan back to the start of this token
      const tokenEnd = pos + 1;
      while (pos >= 0 && !/[\s,]/.test(text[pos])) pos--;
      const tokenStart = pos + 1;
      const token = text.slice(tokenStart, tokenEnd);

      // Accept: capitalized word (ALL CAPS or Title Case), number
      const isNameWord = /^[A-Z][A-Za-z0-9'.&-]*$/.test(token) || /^[0-9]+$/.test(token);
      // Accept: XML-encoded or bare ampersand as connector (but only between name words)
      const isConnector = /^(&amp;|&)$/.test(token) && nameWordCount > 0;

      if (isNameWord) {
        entityStart = tokenStart;
        nameWordCount++;
      } else if (isConnector) {
        entityStart = tokenStart;
      } else {
        break;
      }
    }

    if (nameWordCount === 0) continue;

    // Slice original text to preserve spacing/punctuation exactly
    let value = text.slice(entityStart, suffixEnd).trim();

    // Strip any leading connector that ended up at the front
    value = value.replace(/^(?:&amp;|&)\s*/i, '').trim();

    if (value.length < 3) continue;

    // Find the true start after possible leading-connector trim
    const trueStart = text.indexOf(value, entityStart);
    results.push({
      type:  'ORGANIZATION',
      value,
      start: trueStart >= 0 ? trueStart : entityStart,
      end:   suffixEnd,
    });
  }

  // Remove results that are fully contained within a longer result
  // (e.g. "ASB BLAKE STREET HOLDINGS" inside "ASB BLAKE STREET HOLDINGS LLC")
  return results.filter(r =>
    !results.some(other => other !== r && other.start <= r.start && other.end >= r.end)
  );
}

// Street addresses — number + street name + suffix (+ optional suite/unit)
const STREET_SUFFIXES = 'Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Trail|Terrace|Ter|Plaza|Loop';
const STREET_ADDRESS = new RegExp(
  `\\b\\d{1,6}\\s+[A-Za-z0-9][A-Za-z0-9\\s]+(?:${STREET_SUFFIXES})\\.?(?:\\s+(?:Suite|Ste|#|Apt|Unit|Floor|Fl)\\.?\\s*[A-Za-z0-9]+)?`,
  'g'
);

// P.O. Box addresses
const PO_BOX = /\bP\.?\s*O\.?\s*Box\s+\d+\b/gi;

// US zip codes — 5-digit or ZIP+4
const ZIP_CODE = /\b\d{5}(?:-\d{4})?\b/g;

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

  return results;
}
