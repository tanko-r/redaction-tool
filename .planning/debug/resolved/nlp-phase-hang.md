---
status: resolved
trigger: "App hangs indefinitely at the NLP analysis phase when processing documents. It spins forever with no error."
created: 2026-03-19T00:00:00Z
updated: 2026-03-19T00:01:00Z
symptoms_prefilled: true
---

## Current Focus

hypothesis: CONFIRMED — spawn('python3') uses Python 3.11 which lacks spaCy; process crashes silently; nerReady never set; poll spins forever
test: ran python3 -c "import spacy" → ModuleNotFoundError; ran python -c "import spacy" → ok
expecting: fix was to change 'python3' to 'python' in startNER()
next_action: DONE — fix applied and verified

## Symptoms

expected: NLP phase should complete and proceed to next processing phase (after "Running NLP analysis on 2170 qualifying node(s)...")
actual: Hangs indefinitely at "Running NLP analysis on 2170 qualifying node(s)..." — never completes, never errors
errors: None — just spins forever
reproduction: Upload a .docx file, click "Redact Documents". Processes through uploading, finding text nodes, extracting defined terms, running regex detectors, but then hangs at the NLP phase.
started: Recently broke. detectors/llm.js is currently modified (unstaged).

## Eliminated

- hypothesis: Change to prompt text in detectors/llm.js caused the hang
  evidence: git diff showed only prompt wording changes; hang occurs at NLP/NER phase (line 357-358), not LLM phase
  timestamp: 2026-03-19T00:01:00Z

## Evidence

- timestamp: 2026-03-19T00:01:00Z
  checked: detectors/index.js line 18 — spawn('python3', [NER_SCRIPT])
  found: startNER() uses 'python3' executable
  implication: need to verify which python3 has spaCy

- timestamp: 2026-03-19T00:01:00Z
  checked: python3 --version → Python 3.11.9; python3 -c "import spacy" → ModuleNotFoundError
  found: python3 (3.11.9) does NOT have spaCy installed
  implication: ner.py crashes immediately on startup under python3

- timestamp: 2026-03-19T00:01:00Z
  checked: python --version → Python 3.13.2; python -c "import spacy; nlp=spacy.load('en_core_web_sm')" → "spacy ok"
  found: python (3.13.2) at C:\Python313 DOES have spaCy and en_core_web_sm
  implication: 'python' is the correct executable to use

- timestamp: 2026-03-19T00:01:00Z
  checked: nerProc.stderr suppressed (line 39), nerReady never set, setInterval poll has no timeout
  found: crash is invisible; poll runs forever; promise never resolves/rejects
  implication: this is the exact mechanism of the hang

- timestamp: 2026-03-19T00:01:00Z
  checked: ran ner.py under python with test input
  found: emits {"ready":true} then processes batch correctly
  implication: fix confirmed working

## Resolution

root_cause: spawn('python3', [NER_SCRIPT]) in startNER() uses Python 3.11.9, which does not have spaCy installed. The script crashes immediately with ModuleNotFoundError. stderr is suppressed (line 39), so the crash is invisible. nerReady is never set to true. The setInterval poll in nerDetect() has no timeout, so it spins forever, causing the infinite hang at the NLP phase. spaCy is installed under 'python' (Python 3.13.2 at C:\Python313).
fix: Changed spawn('python3', ...) to spawn('python', ...) in detectors/index.js line 18.
verification: Ran ner.py directly under 'python' with test input — emits {"ready":true} and processes NER correctly.
files_changed: [detectors/index.js]
