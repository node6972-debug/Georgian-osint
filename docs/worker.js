// Worker: parses JSONL, holds records in memory, answers searches.

let records = [];
let manifest = null;
let loadedShards = new Set();

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "load-single") {
      const text = await fetchText(msg.url, (p) => post({ type: "progress", p, label: "Downloading" }));
      post({ type: "progress", p: 1, label: "Parsing" });
      records = parseJsonl(text);
      post({ type: "loaded", count: records.length, mode: "single" });
    }
    else if (msg.type === "load-manifest") {
      manifest = msg.manifest;
      post({ type: "manifest-ready", manifest });
    }
    else if (msg.type === "load-shards") {
      const want = msg.shards.filter((s) => !loadedShards.has(s));
      if (want.length === 0) {
        post({ type: "shards-loaded", shards: msg.shards });
        return;
      }
      let done = 0;
      for (const shard of want) {
        const text = await fetchText(`/db/shards/${encodeURIComponent(shard)}.jsonl`);
        const rows = parseJsonl(text);
        records.push(...rows);
        loadedShards.add(shard);
        done++;
        post({ type: "progress", p: done / want.length, label: `Loading shard ${done}/${want.length}` });
      }
      post({ type: "shards-loaded", shards: Array.from(loadedShards) });
    }
    else if (msg.type === "search") {
      const result = search(msg.query);
      post({ type: "results", requestId: msg.requestId, ...result });
    }
    else if (msg.type === "reset") {
      records = [];
      loadedShards = new Set();
      post({ type: "reset-done" });
    }
  } catch (err) {
    post({ type: "error", message: String(err && err.message || err) });
  }
};

function post(m) { self.postMessage(m); }

async function fetchText(url, onProgress) {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !onProgress) return await res.text();

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
  // Concatenate
  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return new TextDecoder("utf-8").decode(buf);
}

function parseJsonl(text) {
  const out = [];
  let i = 0, n = text.length;
  while (i < n) {
    let j = text.indexOf("\n", i);
    if (j === -1) j = n;
    if (j > i) {
      try {
        out.push(JSON.parse(text.slice(i, j)));
      } catch { /* skip malformed line */ }
    }
    i = j + 1;
  }
  return out;
}

// ---------- search ----------
//
// All terms must match (AND). A term matches if it appears as a substring
// (case-insensitive) in any of the searchable fields. Numeric terms are
// also matched against the ID and mobile fields.

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
  const ageMin = query.ageMin;
  const ageMax = query.ageMax;
  const sex = query.sex;
  const source = query.source;
  const sort = query.sort || "";
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
      if (la < lb) return -1; if (la > lb) return 1;
      const fa = (a.fn || "").toLowerCase(), fb = (b.fn || "").toLowerCase();
      if (fa < fb) return -1; if (fa > fb) return 1;
      return 0;
    });
  } else if (sort === "age_asc") {
    results.sort((a, b) => (b.by || 0) - (a.by || 0));
  } else if (sort === "age_desc") {
    results.sort((a, b) => (a.by || 0) - (b.by || 0));
  }

  const total = results.length;
  const start = (page - 1) * perPage;
  const slice = results.slice(start, start + perPage);
  return { total, page, perPage, terms, results: slice };
}