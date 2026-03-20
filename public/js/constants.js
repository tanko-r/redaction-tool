// Confidence thresholds (ported from detectors/llm.js)
export const CONFIDENCE = {
  EMAIL:            0.97,
  PHONE:            0.95,
  LEGAL_DESCRIPTION:0.95,
  AMOUNT_SIGN:      0.95,
  ADDRESS:          0.90,
  ALLCAPS_ENTITY:   0.75,
  DATE_LONG:        0.90,
  DATE_ISO:         0.88,
  DATE_ORDINAL:     0.87,
  DATE_SHORT:       0.82,
  AMOUNT_WORD:      0.80,
  ZIP:              0.95,
  MIXED_ENTITY_LONG:0.72,
  MIXED_ENTITY_MED: 0.60,
  NER_PERSON:       0.60,
  NER_ORG:          0.50,
  NER_MONEY:        0.85,
};

export const LLM_THRESHOLD = 0.78;
export const MAX_WORDS = 10;
export const WORDCOUNT_EXEMPT = new Set(['ADDRESS', 'AMOUNT', 'LEGAL_DESCRIPTION', 'ZIP']);
export const NER_WORDCOUNT_EXEMPT = new Set(['MONEY']);
export const NER_MIN_LENGTH = 4;
export const BATCH_SIZE = 15;
