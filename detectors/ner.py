"""
Persistent spaCy NER worker.
Protocol: reads one JSON line from stdin (array of strings),
writes one JSON line to stdout (array of entity lists).
Stays alive so the model is only loaded once.
"""
import sys
import json
import re
import spacy

# Strip lone surrogates that break JSON serialisation
_SURROGATE_RE = re.compile(r'[\ud800-\udfff]')
def _clean(s):
    return _SURROGATE_RE.sub('', s)

nlp = spacy.load("en_core_web_sm")

# Role/contract words that spaCy incorrectly tags as PERSON
PERSON_BLOCKLIST = {
    'seller', 'purchaser', 'buyer', 'agent', 'broker', 'escrow', 'closing',
    'party', 'parties', 'grantor', 'grantee', 'trustee', 'beneficiary',
    'witness', 'notary', 'officer', 'manager', 'member', 'owner', 'tenant',
    'landlord', 'lessee', 'lessor', 'assignee', 'assignor', 'guarantor',
    'representative', 'attorney', 'counsel', 'principal', 'director',
    'president', 'secretary', 'treasurer', 'signatory', 'executor',
    'administrator', 'heir', 'devisee', 'mortgagor', 'mortgagee',
}

# Generic ORG-like phrases that spaCy tags as ORG but are not entity names
ORG_BLOCKLIST = {
    # Generic role/contract terms
    'seller', 'purchaser', 'buyer', 'agent', 'broker', 'escrow', 'party',
    'parties', 'grantor', 'grantee', 'trustee', 'beneficiary', 'guarantor',
    'assignee', 'assignor', 'lessor', 'lessee', 'landlord', 'tenant',
    'representative', 'attorney', 'counsel', 'manager', 'member', 'owner',
    # Generic descriptor phrases
    'title company', 'escrow agent', 'title insurance', 'escrow company',
    'earnest money', 'real estate', 'the company', 'limited liability company',
    'limited partnership', 'general partnership', 'title officer',
    'title review', 'title commitment', 'title policy', 'title report',
}

# Business suffixes — an ORG ending with one of these is likely a real entity name
ORG_BUSINESS_SUFFIXES = {
    'corporation', 'corp', 'inc', 'incorporated', 'llc', 'l.l.c.', 'ltd',
    'lp', 'llp', 'l.p.', 'company', 'co', 'trust', 'foundation',
    'partners', 'partnership', 'associates', 'group', 'holdings',
    'authority', 'association', 'institute', 'bank', 'fund',
    'ps', 'p.s.', 'plc', 'services', 'solutions',
}

# Words at the END of an ORG entity that indicate a legal defined term, not a company
ORG_TERM_ENDINGS = {
    'date', 'period', 'deadline', 'notice', 'condition', 'obligation',
    'event', 'right', 'option', 'requirement', 'schedule', 'threshold',
    'price', 'cost', 'fee', 'term', 'terms', 'approval', 'consent',
    'extension', 'expiration', 'commencement', 'termination', 'closing',
    # Legal/property planning phrases
    'subdivision', 'development', 'review', 'affidavit', 'warranty',
    'representation', 'proceedings', 'covenant', 'restriction', 'easement',
    'amendment', 'modification', 'entitlement', 'agreement', 'section',
    'plan', 'report', 'permit', 'certificate', 'policy', 'commitment',
    # Financial/other
    'money', 'funds', 'proceeds', 'deposit', 'time', 'zone',
    'conditions', 'provisions', 'obligations', 'rights', 'interests',
    'owner', 'owners',
}

# Leading words that indicate a defined term or legal phrase, not an org name
LEADING_NON_ORG_WORDS = {
    'the', 'a', 'an', 'all', 'any', 'each', 'every', 'such',
    'no', 'this', 'that', 'these', 'those', 'its', 'their',
    'our', 'your', 'said', 'certain', 'other', 'either',
}

# Common English verbs that start legal phrases but not company names
LEADING_VERB_BLOCKLIST = {
    'pursue', 'execute', 'deliver', 'provide', 'obtain', 'complete',
    'satisfy', 'perform', 'pay', 'give', 'make', 'take', 'use', 'apply',
    'require', 'notify', 'approve', 'consent', 'waive', 'terminate',
    'commence', 'extend', 'exercise', 'close', 'conduct', 'prepare',
}

# Words that indicate a place/property name rather than a personal name
PLACE_TYPE_WORDS = {
    'campus', 'park', 'center', 'centre', 'square', 'tower', 'building',
    'plaza', 'estate', 'terrace', 'court', 'gardens', 'heights',
    'village', 'district', 'complex', 'quarter', 'block', 'commons',
    'place', 'point', 'ridge', 'valley', 'hill', 'meadows',
}

def process_batch(texts):
    results = []
    docs = list(nlp.pipe(texts, batch_size=64))
    for doc in docs:
        ents = []
        for ent in doc.ents:
            text = ent.text.strip()
            lower = text.lower()

            if ent.label_ == 'PERSON':
                # Require at least two tokens (first + last name minimum)
                words = text.split()
                if len(words) < 2:
                    continue
                # Strip possessives for blocklist check
                clean_lower = lower.replace("'s", '').replace("\u2019s", '').strip()
                if clean_lower in PERSON_BLOCKLIST:
                    continue
                # Also block if ANY word (stripped of possessives) is a role word
                if any(w.lower().rstrip("'s\u2019s.,;") in PERSON_BLOCKLIST for w in words):
                    continue
                ents.append({'type': 'PERSON', 'value': text,
                             'start': ent.start_char, 'end': ent.end_char})

            elif ent.label_ == 'ORG':
                if lower in ORG_BLOCKLIST:
                    continue
                words = text.split()
                last_word = words[-1].lower().rstrip('.,;')
                first_word = words[0].lower()
                # Skip single-word ORGs unless they have a business suffix
                if len(words) < 2:
                    if last_word not in ORG_BUSINESS_SUFFIXES:
                        continue
                # "the/a/an/all/any/..." X patterns → usually defined terms, not org names
                # unless they end with a recognised business suffix
                if first_word in LEADING_NON_ORG_WORDS and last_word not in ORG_BUSINESS_SUFFIXES:
                    continue
                # Leading English verb → legal phrase, not an org name
                if first_word in LEADING_VERB_BLOCKLIST:
                    continue
                # First word is a contract role term → "Purchaser Conditions", "Seller's Remedies", etc.
                if first_word.rstrip("'s\u2019s") in PERSON_BLOCKLIST and last_word not in ORG_BUSINESS_SUFFIXES:
                    continue
                # Ends in a legal schedule/event word → defined term, not a company name
                if last_word in ORG_TERM_ENDINGS:
                    continue
                ents.append({'type': 'ORG', 'value': text,
                             'start': ent.start_char, 'end': ent.end_char})

            elif ent.label_ == 'MONEY':
                ents.append({'type': 'MONEY', 'value': text,
                             'start': ent.start_char, 'end': ent.end_char})

        results.append(ents)
    return results


# Signal readiness
print(json.dumps({'ready': True}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        texts = [_clean(t) for t in json.loads(line)]
        results = process_batch(texts)
        print(json.dumps(results, ensure_ascii=True), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e)}), flush=True)
