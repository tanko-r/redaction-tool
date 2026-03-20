# Redaction Tool

Browser-based tool for sanitizing client or matter-specific information from legal `.docx` documents, all run completely on-device. Uploads produce clean, properly-formatted `.docx` outputs with sensitive information replaced by `[TYPE]` placeholders.

## What gets redacted

| Category | Examples |
|---|---|
| People & entities | Names, company names, LLCs, LLPs |
| Dollar amounts | `$86,050,000`, `Eighty-Six Million Dollars` |
| Addresses | Street addresses, P.O. boxes |
| Contact info | Phone numbers, email addresses |
| Dates | All common formats |
| Legal descriptions | Lot/Block, Tax Parcel numbers, metes-and-bounds triggers |

**Defined terms are preserved automatically.** Any word or phrase appearing in quotation marks in the document (e.g. `"Seller"`, `"Agreement"`) is extracted and excluded from redaction everywhere it appears.

## Detection pipeline

1. **Regex detectors** — high-confidence types (email, phone, dollar amounts, addresses, dates, all-caps entity names). These pass straight through.
2. **spaCy NER** (`en_core_web_sm`) — catches person and organization names that regex misses. Runs as a persistent Python subprocess so the model loads once.
3. **Llama second-opinion filter** — low-confidence detections (NER person/org names, mixed-case entities) are batched and sent to a local `llama3.2:3b` model via Ollama. The LLM decides Y/N for each candidate. High-confidence detections skip this step entirely.

The GUI shows the source of each detection (Regex / NLP / Llama), the confidence score, and an expandable Llama trace with the exact prompt and response for every batch.

## Whitelist

- **Session whitelist** — click *Keep* on any flagged passage to suppress it for the current session, then click *Re-process*.
- **Global whitelist** — click *☆ Global* to preserve a term across sessions (stored in `localStorage`). Starred terms are always preserved from redaction.
- **Manual terms** — enter comma-separated terms in the *What gets redacted* panel before processing.

## Requirements

- **Node.js** 18+
- **Python** 3.9+ with spaCy:
  ```bash
  pip install spacy
  python -m spacy download en_core_web_sm
  ```
- **Ollama** with `llama3.2:3b` (requires ~2 GB RAM for the model):
  ```bash
  curl -fsSL https://ollama.com/install.sh | sh
  ollama pull llama3.2:3b
  ```
  Ollama must be running (`ollama serve`) before starting the server. If it is unavailable, the tool falls back to redacting all low-confidence detections without LLM review.

## Quickstart

```bash
git clone https://github.com/tanko-r/redaction-tool
cd redaction-tool
npm install
node server.js
```

Open [http://localhost:3737](http://localhost:3737), drag in one or more `.docx` files, and click **Redact Documents**.
