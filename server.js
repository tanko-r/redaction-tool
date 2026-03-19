import express from 'express';
import multer from 'multer';
import JSZip from 'jszip';
import { fileURLToPath } from 'url';
import path from 'path';
import { redactTexts, extractDefinedTerms } from './detectors/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// XML parts within a docx that may contain visible text
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

// Extract all <w:t> text content from an XML string along with their positions
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

// Rebuild XML with redacted text nodes
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

async function redactDocx(buffer, userWhitelist = new Set(), progress = () => {}) {
  const zip = await JSZip.loadAsync(buffer);

  // Collect all text part XMLs
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

  // Step 1: Extract defined terms from the entire document
  const definedTerms = extractDefinedTerms(allTexts);
  progress({ msg: `Extracted ${definedTerms.size} defined term(s) to preserve`, pct: 18 });

  // Step 2: Redact all text nodes
  const { redacted, llmLog, changedNodes } = await redactTexts(allTexts, definedTerms, userWhitelist, progress);

  // Step 3: Rebuild each XML part and write back into the zip
  progress({ msg: 'Rebuilding document...', pct: 93 });
  let offset = 0;
  for (const part of parts) {
    const count = part.nodes.length;
    const partRedacted = redacted.slice(offset, offset + count);
    offset += count;
    const newXml = rebuildXml(part.xml, part.nodes, partRedacted);
    zip.file(part.filename, newXml);
  }

  const outputBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    buffer: outputBuffer,
    redactedNodeCount: changedNodes.length,
    definedTermCount: definedTerms.size,
    changedNodes,
    llmLog,
  };
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.post('/redact', upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  // Parse user whitelist from form field (JSON array of lowercase strings)
  let userWhitelist = new Set();
  try {
    const raw = req.body && req.body.whitelist;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) userWhitelist = new Set(parsed.map(s => s.toLowerCase()));
    }
  } catch { /* ignore malformed whitelist */ }

  // Stream NDJSON progress updates + final result
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  const send = obj => res.write(JSON.stringify(obj) + '\n');

  try {
    const results = [];
    for (let fi = 0; fi < req.files.length; fi++) {
      const file = req.files[fi];
      const fileLabel = req.files.length > 1 ? `[${fi + 1}/${req.files.length}] ${file.originalname}` : file.originalname;
      send({ type: 'progress', msg: `Processing ${fileLabel}`, pct: 10 });

      const progress = ({ msg, pct }) => send({ type: 'progress', msg: `${fileLabel}: ${msg}`, pct });

      const { buffer, redactedNodeCount, definedTermCount, changedNodes, llmLog } =
        await redactDocx(file.buffer, userWhitelist, progress);

      send({ type: 'progress', msg: `${fileLabel}: done — ${redactedNodeCount} passage(s) redacted`, pct: 97 });

      results.push({
        originalName: file.originalname,
        redactedName: file.originalname.replace(/\.docx$/i, '_REDACTED.docx'),
        buffer: buffer.toString('base64'),
        redactedNodeCount,
        definedTermCount,
        changedNodes: changedNodes.slice(0, 500),
        llmLog,
      });
    }

    send({ type: 'result', results });
  } catch (err) {
    console.error(err);
    send({ type: 'error', error: err.message });
  }

  res.end();
});

const PORT = process.env.PORT || 3737;
app.listen(PORT, () => console.log(`Redaction tool running at http://localhost:${PORT}`));
