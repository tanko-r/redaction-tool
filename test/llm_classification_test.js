/**
 * LLM Classification Test — send representative prompts to the configured
 * Ollama model and verify it returns compact JSON arrays without thinking loops.
 *
 * Usage:  node test/llm_classification_test.js [model]
 * e.g.:   node test/llm_classification_test.js llama3.2:1b
 *         node test/llm_classification_test.js llama3.2:3b
 *         node test/llm_classification_test.js phi3:mini
 *         node test/llm_classification_test.js gemma2:2b
 *         node test/llm_classification_test.js qwen2.5:1.5b
 */

const MODEL   = process.argv[2] || 'qwen2.5:1.5b-instruct';
const URL     = 'http://localhost:11434/api/generate';
const TIMEOUT = 60_000;

// Each batch mimics what the redaction engine sends.
// Expected answers are noted in comments — not sent to the model.
const TEST_BATCHES = [
  {
    label: 'Batch A — obvious mix',
    items: [
      { type: 'PERSON', value: 'John D. Smith',           context: 'The Seller, John D. Smith, hereby conveys the property.' },
      { type: 'ORG',    value: 'Effective Date',           context: 'This Agreement is entered into as of the Effective Date.' },
      { type: 'ORG',    value: 'Pacific Realty LLC',       context: 'Buyer is Pacific Realty LLC, a Washington limited liability company.' },
      { type: 'ORG',    value: 'Title Company',            context: 'Closing shall occur through a licensed Title Company.' },
      { type: 'PERSON', value: 'Maria Gonzalez',           context: 'Tenant Maria Gonzalez shall vacate the premises by Friday.' },
    ],
    expected: ['Y', 'N', 'Y', 'N', 'Y'],
  },
  {
    label: 'Batch B — legal boilerplate traps',
    items: [
      { type: 'ORG',    value: 'Indemnified Party',        context: 'The Indemnified Party shall be held harmless from all claims.' },
      { type: 'ORG',    value: 'Borrower',                 context: 'Borrower agrees to repay the loan pursuant to the terms herein.' },
      { type: 'ORG',    value: 'ASB Capital Management LLC', context: 'Lender is ASB Capital Management LLC, a Delaware company.' },
      { type: 'ORG',    value: 'King County',              context: 'Property is located in King County, Washington.' },
      { type: 'PERSON', value: 'Waiver Party',             context: 'Waiver Party acknowledges that no waiver shall be implied.' },
    ],
    expected: ['N', 'N', 'Y', 'N', 'N'],
  },
  {
    label: 'Batch C — NER false-positive stress test',
    items: [
      { type: 'ORG',    value: 'Material Casualty',        context: 'In the event of a Material Casualty, Seller may terminate.' },
      { type: 'ORG',    value: 'Material Taking',          context: 'A Material Taking means condemnation of more than 20%.' },
      { type: 'ORG',    value: 'Puget Sound Energy',       context: 'Utilities are provided by Puget Sound Energy.' },
      { type: 'ORG',    value: 'Arbitration Panel',        context: 'Disputes shall be resolved before an Arbitration Panel.' },
      { type: 'PERSON', value: 'Robert T. Williams III',   context: 'Guarantor: Robert T. Williams III, an individual.' },
    ],
    expected: ['N', 'N', 'Y', 'N', 'Y'],
  },
  {
    label: 'Batch D — named entities vs. defined roles',
    items: [
      { type: 'ORG',    value: 'Seattle Housing Authority', context: 'Property is managed by Seattle Housing Authority.' },
      { type: 'ORG',    value: 'Permitted Exceptions',      context: 'Title shall be subject only to the Permitted Exceptions.' },
      { type: 'PERSON', value: 'the Trustee',               context: 'All funds are held by the Trustee pending closing.' },
      { type: 'ORG',    value: 'Cascade Investment Group',  context: 'Seller is Cascade Investment Group, a Washington partnership.' },
      { type: 'ORG',    value: 'Force Majeure Event',       context: 'A Force Majeure Event excuses performance under Section 14.' },
    ],
    expected: ['Y', 'N', 'N', 'Y', 'N'],
  },
  {
    label: 'Batch E — tricky edge cases',
    items: [
      { type: 'ORG',    value: 'Washington State',           context: 'This contract is governed by the laws of Washington State.' },
      { type: 'ORG',    value: 'Sunrise Capital Partners',   context: 'Sunrise Capital Partners, LP is the Buyer hereunder.' },
      { type: 'ORG',    value: 'Closing Agent',              context: 'The Closing Agent shall disburse funds at settlement.' },
      { type: 'PERSON', value: 'Jennifer L. Park',           context: 'Executed by Jennifer L. Park, as authorized signatory.' },
      { type: 'ORG',    value: 'Default Notice',             context: 'Seller shall deliver a Default Notice within five (5) days.' },
    ],
    expected: ['N', 'Y', 'N', 'Y', 'N'],
  },
];

const CTX_CHARS = 80;
function buildContext(context, value) {
  const idx = context.indexOf(value);
  if (idx === -1) return context.length > CTX_CHARS * 2 ? '...' + context.slice(-(CTX_CHARS * 2)) : context;
  const lo = Math.max(0, idx - CTX_CHARS);
  const hi = Math.min(context.length, idx + value.length + CTX_CHARS);
  return (lo > 0 ? '...' : '') + context.slice(lo, hi) + (hi < context.length ? '...' : '');
}

function buildPrompt(items) {
  const lines = items.map((c, i) => {
    const ctx = buildContext(c.context, c.value);
    return `${i + 1}. [${c.type}] "${c.value}" in: "${ctx}"`;
  });
  return (
    `Classify each entity: Y = redact (real name), N = keep (generic term).\n\n` +
    `EXAMPLES:\n` +
    `[PERSON] "James A. Carter" → Y (real person name)\n` +
    `[PERSON] "Elena Vasquez" → Y (real person name)\n` +
    `[PERSON] "Thomas R. Bennett Jr." → Y (real person name)\n` +
    `[PERSON] "the Guarantor" → N (generic role, not a name)\n` +
    `[PERSON] "Beneficiary" → N (generic role)\n` +
    `[PERSON] "Lender" → N (generic role)\n` +
    `[ORG] "Greenfield Properties LLC" → Y (specific company — has LLC)\n` +
    `[ORG] "Apex Commercial Lending Inc" → Y (specific company — has Inc)\n` +
    `[ORG] "Northstar Capital Advisors" → Y (specific firm name)\n` +
    `[ORG] "Columbia River Electric" → Y (specific utility company)\n` +
    `[ORG] "Portland Development Commission" → Y (specific government agency)\n` +
    `[ORG] "Redwood Equity Partners" → Y (specific firm name)\n` +
    `[ORG] "Secured Party" → N (generic role)\n` +
    `[ORG] "Escrow Company" → N (generic placeholder)\n` +
    `[ORG] "Settlement Agent" → N (generic role)\n` +
    `[ORG] "Review Board" → N (generic body)\n` +
    `[ORG] "Substantial Damage" → N (legal defined term)\n` +
    `[ORG] "Partial Condemnation" → N (legal defined term)\n` +
    `[ORG] "Act of God" → N (legal defined term)\n` +
    `[ORG] "Commencement Date" → N (legal defined term)\n` +
    `[ORG] "Cure Notice" → N (legal defined term)\n` +
    `[ORG] "Excluded Assets" → N (legal defined term)\n` +
    `[ORG] "Clark County" → N (jurisdiction)\n` +
    `[ORG] "Oregon State" → N (jurisdiction)\n\n` +
    `Key: [PERSON] "Firstname Lastname" → Y. [PERSON] "X Party" → N. Fragments → N.\n\n` +
    `NOW CLASSIFY:\n` +
    lines.join('\n')
  );
}

async function runBatch(batch) {
  const prompt = buildPrompt(batch.items);
  const start  = Date.now();

  const resp = await fetch(URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model: MODEL, prompt, stream: false,
      format: (() => {
        const properties = {}, required = [];
        batch.items.forEach((_, i) => { const k = String(i+1); properties[k] = { type: 'string', enum: ['Y','N'] }; required.push(k); });
        return { type: 'object', properties, required };
      })(),
      options: { temperature: 0, num_predict: batch.items.length * 12 },
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const raw  = (data.response || '').trim();

  let verdicts;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      verdicts = parsed.map(v => String(v).toUpperCase().trim());
    } else if (parsed && typeof parsed === 'object') {
      verdicts = batch.items.map((_, i) => String(parsed[String(i+1)] ?? 'Y').toUpperCase().trim());
    } else { throw new Error('unexpected'); }
  } catch {
    return { ok: false, raw, elapsed, verdicts: [], correct: 0, total: batch.items.length };
  }

  let correct = 0;
  verdicts.forEach((v, i) => { if (v === batch.expected[i]) correct++; });

  return { ok: true, raw, elapsed, verdicts, correct, total: batch.items.length };
}

async function main() {
  console.log(`\nModel: ${MODEL}\n${'─'.repeat(60)}`);
  let totalCorrect = 0, totalItems = 0;

  for (const batch of TEST_BATCHES) {
    process.stdout.write(`${batch.label} ... `);
    try {
      const r = await runBatch(batch);
      if (!r.ok) {
        console.log(`FAIL — no valid JSON array\n  raw: ${r.raw.slice(0, 300)}`);
        totalItems += r.total;
        continue;
      }
      const pct = Math.round((r.correct / r.total) * 100);
      console.log(`${r.correct}/${r.total} correct (${pct}%)  [${r.elapsed}s]`);
      batch.items.forEach((item, i) => {
        const got = r.verdicts[i] ?? '?';
        const exp = batch.expected[i];
        if (got !== exp) console.log(`  ✗ [${i+1}] "${item.value}" → got ${got}, expected ${exp}`);
      });
      totalCorrect += r.correct;
      totalItems   += r.total;
    } catch (err) {
      console.log(`ERROR — ${err.message}`);
      totalItems += batch.items.length;
    }
  }

  const pct = totalItems ? Math.round(totalCorrect / totalItems * 100) : 0;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Overall: ${totalCorrect}/${totalItems} correct (${pct}%)\n`);
}

main().catch(console.error);
