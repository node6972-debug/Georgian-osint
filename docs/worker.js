// Worker: fetches (possibly chunked + gzipped) CSVs from GitHub Pages,
// classifies each row, keeps records in memory, answers searches
// without blocking the UI.

let records = [];

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      records = [];
      const totalSources = msg.sources.length;
      let completed = 0;

      const results = await Promise.allSettled(msg.sources.map(async (src) => {
        const text = await fetchSource(src, (p) =>
          post({ type: "progress", p, label: `Loading ${src.label}` }));
        const rows = parseCsvToRecords(text, src.label);
        completed++;
        post({ type: "progress", p: 1,
               label: `${src.label} parsed (${rows.length.toLocaleString()}) — ${completed}/${totalSources} done` });
        return rows;
      }));

      for (const r of results) {
        if (r.status === "fulfilled") {
          const rows = r.value;
          for (let i = 0; i < rows.length; i++) records.push(rows[i]);
        } else {
          post({ type: "error", message: `Source failed: ${r.reason && r.reason.message}` });
        }
      }
      post({ type: "loaded", count: records.length });
    }
    else if (msg.type === "search") {
      post({ type: "results", requestId: msg.requestId, ...search(msg.query) });
    }
  } catch (err) {
    post({ type: "error", message: String(err && err.message || err) });
  }
};

function post(m) { self.postMessage(m); }

// ---------------------------------------------------------------------------
// Fetching — single file or chunks, optional gzip
// ---------------------------------------------------------------------------

function chunkSuffix(i) {
  const a = Math.floor(i / 26), b = i % 26;
  return String.fromCharCode(97 + a) + String.fromCharCode(97 + b);
}

async function fetchSource(src, onProgress) {
  let bytes;
  if (src.chunks && src.chunks > 0) {
    const parts = [];
    for (let i = 0; i < src.chunks; i++) {
      const url = `${src.baseUrl}.part-${chunkSuffix(i)}`;
      const buf = await fetchBytes(url, (p) => onProgress((i + p) / src.chunks));
      parts.push(buf);
    }
    bytes = concatBytes(parts);
  } else {
    bytes = await fetchBytes(src.url || src.baseUrl, onProgress);
  }
  if (src.gzipped) bytes = await gunzip(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

async function fetchBytes(url, onProgress) {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;

  if (!res.body || !onProgress) {
    return new Uint8Array(await res.arrayBuffer());
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress(received / total);
  }
  return concatBytes(chunks);
}

function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------
// CSV parsing + classifier
// ---------------------------------------------------------------------------

const RE_ID     = /^\s*\d{11}\s*$/;
const RE_MOBILE = /^\s*(?:\+?995)?[\s\-]*(5\d{2})[\s\-]?(\d{3})[\s\-]?(\d{3})\s*$/;
const RE_SEX    = /^\s*(M|F|მ|ქ|კ|მამრ\.?|მდედრ\.?|ქალი|კაცი|male|female)\s*$/i;
const RE_DATE   = /^\s*(\d{1,4})[./\-](\d{1,2})[./\-](\d{1,4})(?:[\sT]+\d{1,2}:\d{2}(?::\d{2})?)?\s*$/;
const RE_HAS_DIGIT = /\d/;
const ADDRESS_KEYWORDS = [
  "ქუჩა", "გამზირი", "ქ.", "ქალაქი", "სოფელი", "დასახლება",
  "შესახვევი", "მიკრორაიონი", "რაიონი", "პროსპექტი",
  "street", " st.", " ave", "avenue", "district", "city", "village",
];

function parseCsvLine(s, delim) {
  const out = [];
  let i = 0, n = s.length;
  while (i <= n) {
    while (i < n && (s[i] === " " || s[i] === "\t")) i++;
    if (i < n && s[i] === '"') {
      i++;
      let buf = "";
      while (i < n) {
        if (s[i] === '"') {
          if (i + 1 < n && s[i + 1] === '"') { buf += '"'; i += 2; continue; }
          i++; break;
        }
        buf += s[i++];
      }
      out.push(buf);
      while (i < n && s[i] !== delim) i++;
    } else {
      const j = s.indexOf(delim, i);
      const end = j === -1 ? n : j;
      out.push(s.slice(i, end).trim());
      i = end;
    }
    if (i >= n) break;
    i++;
  }
  return out;
}

function sniffDelimiter(sample) {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQ = false;
  for (const ch of sample) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseDateField(s) {
  if (!s) return [null, null];
  s = s.trim();
  const m = s.match(RE_DATE);
  if (!m) return [null, null];
  const a = m[1], b = m[2], c = m[3];
  const head = s.split(" ")[0].split("T")[0];
  const sep = head.includes(".") ? "." : (head.includes("/") ? "/" : "-");
  try {
    let y, mo, d;
    if (a.length === 4 && c.length <= 2) {
      y = +a; mo = +b; d = +c;
    } else {
      if (c.length === 4) y = +c;
      else if (a.length === 4) y = +a;
      else { const yy = +c; y = yy + (yy > 30 ? 1900 : 2000); }
      const n1 = +a, n2 = +b;
      if (sep === "/") { mo = n1; d = n2; }
      else { d = n1; mo = n2; }
      if (mo < 1 || mo > 12) { [mo, d] = [d, mo]; }
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return [null, null];
    return [`${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, y];
  } catch { return [null, null]; }
}

function normaliseMobile(fs) {
  let d = fs.replace(/\D/g, "");
  if (d.startsWith("995")) d = d.slice(3);
  return d;
}

function normaliseSex(fs) {
  const v = fs.trim().toLowerCase().replace(/\.$/, "");
  if (["m", "მ", "კ", "მამრ", "კაცი", "male"].includes(v)) return "M";
  if (["f", "ქ", "მდედრ", "ქალი", "female"].includes(v)) return "F";
  return null;
}

function classifyLine(raw, delim, source) {
  const fields = parseCsvLine(raw, delim).filter((f) => f.trim() !== "");
  const rec = {
    fn: null, ln: null, father: null, id: null,
    dob: null, by: null, sex: null, addr: null, mob: null,
    src: source,
  };
  const names = [], leftovers = [];

  for (const f of fields) {
    const fs = f.trim();
    if (!fs) continue;
    if (RE_ID.test(fs)) { rec.id = fs.replace(/\s/g, ""); continue; }
    if (RE_MOBILE.test(fs)) { rec.mob = normaliseMobile(fs); continue; }
    const [d, y] = parseDateField(fs);
    if (d) { rec.dob = d; rec.by = y; continue; }
    const sx = normaliseSex(fs);
    if (sx && fs.length <= 12) { rec.sex = sx; continue; }
    const low = fs.toLowerCase();
    if (ADDRESS_KEYWORDS.some((k) => low.includes(k))) {
      rec.addr = rec.addr ? rec.addr + " " + fs : fs;
      continue;
    }
    if (!RE_HAS_DIGIT.test(fs)) names.push(fs);
    else leftovers.push(fs);
  }

  if (names[0]) rec.fn = names[0];
  if (names[1]) rec.ln = names[1];
  if (names[2]) rec.father = names[2];
  if (names.length > 3) leftovers.push(...names.slice(3));
  if (leftovers.length) rec.extra = leftovers;

  if (!rec.fn && !rec.ln && !rec.id && !rec.mob) return null;
  return rec;
}

function classifyByColumns(fields, columns, source) {
  const rec = {
    fn: null, ln: null, father: null, id: null,
    dob: null, by: null, sex: null, addr: null, mob: null,
    src: source.label || source.src,
  };

  for (let i = 0; i < columns.length && i < fields.length; i++) {
    const val = fields[i] != null ? String(fields[i]).trim() : "";
    if (!val) continue;
    switch (columns[i]) {
      case "id":       rec.id = val.replace(/\s/g, ""); break;
      case "fn":       rec.fn = val; break;
      case "ln":       rec.ln = val; break;
      case "father":   rec.father = val; break;
      case "dob": {
        const [d, y] = parseDateField(val);
        if (d) { rec.dob = d; rec.by = y; }
        break;
      }
      case "sex":      rec.sex = normaliseSex(val); break;
      case "sexNum":
        if (val === "1") rec.sex = "M";
        else if (val === "2") rec.sex = "F";
        else rec.sex = normaliseSex(val);
        break;
      case "addr":     rec.addr = rec.addr ? rec.addr + " " + val : val; break;
      case "district": rec.addr = rec.addr ? rec.addr + ", " + val : val; break;
      case "mob":      rec.mob = normaliseMobile(val); break;
      // "skip" and anything else → ignored
    }
  }

  if (!rec.fn && !rec.ln && !rec.id && !rec.mob) return null;
  return rec;
}

function parseCsvToRecords(text, source) {
  const delim = sniffDelimiter(text.slice(0, 4096));
  const out = [];
  const columns = source.columns || null;
  let i = 0, n = text.length, lineNo = 0;
  while (i < n) {
    let j = text.indexOf("\n", i);
    if (j === -1) j = n;
    const line = text.slice(i, j).replace(/\r$/, "");
    i = j + 1;
    lineNo++;
    if (lineNo === 1) continue;   // skip header
    if (!line.trim()) continue;
    const rec = columns
      ? classifyByColumns(parseCsvLine(line, delim), columns, source)
      : classifyLine(line, delim, source);
    if (rec) out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const FIELD_ORDER = ["fn", "ln", "father", "id", "mob", "addr", "dob", "extra"];

function fieldText(rec, field) {
  const v = rec[field];
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(" ");
  return String(v);
}

function search(query) {
  const q = (query.q || "").trim();
  const terms = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const { ageMin, ageMax, sex, source, sort } = query;
  const page = Math.max(1, query.page || 1);
  const perPage = Math.max(1, Math.min(200, query.perPage || 50));

  const yearNow = new Date().getFullYear();
  const results = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (source && r.src !== source) continue;
    if (sex && r.sex !== sex) continue;
    if (ageMin != null || ageMax != null) {
      if (r.by == null) continue;
      const age = yearNow - r.by;
      if (ageMin != null && age < ageMin) continue;
      if (ageMax != null && age > ageMax) continue;
    }
    if (terms.length) {
      let ok = true;
      for (const t of terms) {
        let hit = false;
        for (const f of FIELD_ORDER) {
          const v = fieldText(r, f).toLowerCase();
          if (v && v.includes(t)) { hit = true; break; }
        }
        if (!hit) { ok = false; break; }
      }
      if (!ok) continue;
    }
    results.push(r);
  }

  if (sort === "name") {
    results.sort((a, b) => {
      const la = (a.ln || "").toLowerCase(), lb = (b.ln || "").toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
      const fa = (a.fn || "").toLowerCase(), fb = (b.fn || "").toLowerCase();
      if (fa !== fb) return fa < fb ? -1 : 1;
      return 0;
    });
  } else if (sort === "age_asc") {
    results.sort((a, b) => (b.by || 0) - (a.by || 0));
  } else if (sort === "age_desc") {
    results.sort((a, b) => (a.by || 0) - (b.by || 0));
  }

  const total = results.length;
  const start = (page - 1) * perPage;
  return { total, page, perPage, terms, results: results.slice(start, start + perPage) };
}