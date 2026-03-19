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

// ALL-CAPS entity names with business suffixes — catches what spaCy misses
// e.g. THE CONNER HOMES GROUP, LLC  |  ASB BLAKE STREET HOLDINGS LLC
const ALLCAPS_ENTITY = /\b[A-Z0-9][A-Z0-9\s&,.'()\-]{3,80}?(?:,\s*|\s+)(?:LLC|L\.L\.C\.|CORP(?:ORATION)?|INC(?:ORPORATED)?|LTD|L\.P\.|LLP|HOLDINGS|TRUST|PARTNERS(?:HIP)?|ASSOCIATES?|COMPANY|CO\.)\b\.?/g;

// Street addresses — number + street name + suffix (+ optional suite/unit)
const STREET_SUFFIXES = 'Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Trail|Terrace|Ter|Plaza|Loop';
const STREET_ADDRESS = new RegExp(
  `\\b\\d{1,6}\\s+[A-Za-z0-9][A-Za-z0-9\\s]+(?:${STREET_SUFFIXES})\\.?(?:\\s+(?:Suite|Ste|#|Apt|Unit|Floor|Fl)\\.?\\s*[A-Za-z0-9]+)?`,
  'g'
);

// P.O. Box addresses
const PO_BOX = /\bP\.?\s*O\.?\s*Box\s+\d+\b/gi;

// Mixed-case entity names with business suffixes (catches what spaCy misses due to XML entity encoding)
// e.g. "Alston, Courtnage &amp; Bassetti LLP"  or  "4000 Property LLC"
const ENTITY_SUFFIXES = 'LLC|L\\.L\\.C\\.|Corp(?:oration)?|Inc(?:orporated)?|Ltd|LLP|L\\.P\\.|LP|Trust|Holdings|Partners(?:hip)?|Associates?|Company|Co\\.|PS|P\\.S\\.|PLC|Group|Foundation|Services';
const MIXED_CASE_ENTITY = new RegExp(
  `\\b[A-Z0-9][A-Za-z0-9,.';&\\s()-]{4,80}?(?:,\\s*|\\s+)(?:${ENTITY_SUFFIXES})\\.?\\b`,
  'g'
);

// US zip codes — 5-digit or ZIP+4, only when following a state abbreviation or city
// (loose match — catches most cases in address contexts)
const ZIP_CODE = /\b\d{5}(?:-\d{4})?\b/g;

// Dates in common legal document formats
const DATE_LONG    = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/g;
const DATE_SHORT   = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const DATE_ISO     = /\b\d{4}-\d{2}-\d{2}\b/g;
const DATE_ORDINAL = /\b(?:\d{1,2}(?:st|nd|rd|th)\s+day\s+of\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:,\s+\d{4})?)\b/gi;

// Legal property descriptions — trigger phrases; we redact the entire matched text node
// (The node-level redaction in the caller handles these as "flag the whole node")
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

  tag(findAll(text, EMAIL,         'EMAIL'),       CONFIDENCE.EMAIL,         'regex');
  tag(findAll(text, PHONE,         'PHONE'),       CONFIDENCE.PHONE,         'regex');
  tag(findAll(text, DOLLAR_SIGN,   'AMOUNT'),      CONFIDENCE.AMOUNT_SIGN,   'regex');
  tag(findAll(text, ALLCAPS_ENTITY,'ORGANIZATION'),CONFIDENCE.ALLCAPS_ENTITY,'allcaps');
  tag(findAll(text, STREET_ADDRESS,'ADDRESS'),     CONFIDENCE.ADDRESS,       'regex');
  tag(findAll(text, PO_BOX,        'ADDRESS'),     CONFIDENCE.ADDRESS,       'regex');
  tag(findAll(text, ZIP_CODE,      'ZIP'),         CONFIDENCE.ZIP,           'regex');
  tag(findAll(text, DATE_LONG,     'DATE'),        CONFIDENCE.DATE_LONG,     'regex');
  tag(findAll(text, DATE_SHORT,    'DATE'),        CONFIDENCE.DATE_SHORT,    'regex');
  tag(findAll(text, DATE_ISO,      'DATE'),        CONFIDENCE.DATE_ISO,      'regex');
  tag(findAll(text, DATE_ORDINAL,  'DATE'),        CONFIDENCE.DATE_ORDINAL,  'regex');

  // Mixed-case entity: require at least 15 chars; confidence scales with length
  for (const m of findAll(text, MIXED_CASE_ENTITY, 'ORGANIZATION')) {
    const len = m.value.trim().length;
    if (len >= 15) {
      const confidence = len >= 30 ? CONFIDENCE.MIXED_ENTITY_LONG : CONFIDENCE.MIXED_ENTITY_MED;
      results.push({ ...m, confidence, source: 'mixed' });
    }
  }

  // English word dollar amounts — only include if the match contains a scale word
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
