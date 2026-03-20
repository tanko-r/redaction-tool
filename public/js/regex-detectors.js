// Regex-based detectors — ported from detectors/regex.js for browser use.
import { CONFIDENCE } from './constants.js';

function findAll(text, regex, type) {
  const results = [];
  let m;
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  while ((m = re.exec(text)) !== null) {
    results.push({ type, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return results;
}

const EMAIL = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;
const PHONE = /\(?\b\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/g;
const DOLLAR_SIGN = /\$\s*[\d,]+(?:\.\d{2})?/g;

const NUM_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const SCALE = '(?:hundred|thousand|million|billion)';
const WORD_DOLLAR = new RegExp(
  `\\b${NUM_WORD}(?:[\\s\\-]${NUM_WORD})*(?:\\s+${SCALE}(?:[\\s\\-]${NUM_WORD}(?:[\\s\\-]${NUM_WORD})*(?:\\s+${SCALE})?)*)?(?:\\s+and\\s+(?:no|zero)[-/]\\d+)?(?:\\s+dollars?)?(?=\\s|\\(|$)`,
  'gi'
);

const BUSINESS_SUFFIXES =
  'LLC|L\\.L\\.C\\.|Corp(?:oration)?|Inc(?:orporated)?|Ltd|LLP|L\\.P\\.|LP' +
  '|Trust|Holdings?|Partners(?:hip)?|Associates?|Company|Co\\.' +
  '|PS|P\\.S\\.|PLC|Group|Foundation|Services|Bank|Fund';

const SUFFIX_RE = new RegExp(
  `(?:,\\s*)?\\b(${BUSINESS_SUFFIXES})(?!\\w)`,
  'gi'
);

function readTokenBackward(text, pos) {
  while (pos >= 0 && /[\s,]/.test(text[pos])) pos--;
  if (pos < 0) return null;
  const tokenEnd = pos + 1;
  while (pos >= 0 && !/[\s,]/.test(text[pos])) pos--;
  return { token: text.slice(pos + 1, tokenEnd), tokenStart: pos + 1, newPos: pos };
}

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
    let suffixEnd = sm.index + sm[0].length;
    if (text[suffixEnd] === '.') suffixEnd++;
    let pos = sm.index - 1;
    while (pos >= 0 && /[\s,]/.test(text[pos])) pos--;
    const { entityStart, nameWordCount } = scanBackForName(text, pos, sm.index);
    if (nameWordCount === 0) continue;
    let value = text.slice(entityStart, suffixEnd).trim();
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
  return results.filter(r =>
    !results.some(other => other !== r && other.start <= r.start && other.end >= r.end)
  );
}

const STREET_SUFFIXES = 'Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Trail|Terrace|Ter|Plaza|Loop';
const STREET_ADDRESS = new RegExp(
  `\\b\\d{1,6}(?:\\s*-\\s*\\d{1,6})?\\s+[A-Za-z0-9][A-Za-z0-9\\s]+(?:${STREET_SUFFIXES})\\.?(?:\\s+(?:Suite|Ste|#|Apt|Unit|Floor|Fl)\\.?\\s*[A-Za-z0-9]+)?`,
  'g'
);
const PO_BOX = /\bP\.?\s*O\.?\s*Box\s+\d+\b/gi;
const ZIP_CODE = /(?<=\b[A-Z]{2}\s)\d{5}(?:-\d{4})?\b/g;
const DATE_LONG    = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/g;
const DATE_SHORT   = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const DATE_ISO     = /\b\d{4}-\d{2}-\d{2}\b/g;
const DATE_ORDINAL = /\b(?:\d{1,2}(?:st|nd|rd|th)\s+day\s+of\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:,\s+\d{4})?)\b/gi;

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

  for (const m of findEntitiesBySuffix(text)) {
    results.push({ ...m, confidence: CONFIDENCE.ALLCAPS_ENTITY, source: 'suffix' });
  }

  const scaleRe = /\b(?:hundred|thousand|million|billion|dollars?)\b/i;
  for (const m of findAll(text, WORD_DOLLAR, 'AMOUNT')) {
    if (scaleRe.test(m.value)) results.push({ ...m, confidence: CONFIDENCE.AMOUNT_WORD, source: 'regex' });
  }

  for (const re of LEGAL_DESC_TRIGGERS) {
    if (findAll(text, re, 'LEGAL_DESCRIPTION').length) {
      results.push({ type: 'LEGAL_DESCRIPTION', value: text, start: 0, end: text.length,
        confidence: CONFIDENCE.LEGAL_DESCRIPTION, source: 'regex' });
      break;
    }
  }

  const EXEMPT = new Set(['EMAIL', 'PHONE', 'AMOUNT', 'ADDRESS', 'ZIP', 'LEGAL_DESCRIPTION']);
  return results.filter(d => EXEMPT.has(d.type) || d.value.trim().split(/\s+/).length <= 10);
}
