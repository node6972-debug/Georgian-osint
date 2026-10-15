(() => {
  "use strict";

  // -----------------------------------------------------------------
  // EDIT THESE TWO BLOCKS. Nothing else needs touching.
  // -----------------------------------------------------------------
  const SOURCE_URLS = [
    {
      label: "2012 census",
      // Paste the URL from the Release asset here after you publish it.
      url: "https://github.com/node6972-debug/Georgian-osint/releases/download/data-v1/Georgia_2012_4.9m.csv.gz",
      gzipped: true,
    },
    {
      label: "2016 registry",
      url: "data/georgian2016.txt.gz",
      gzipped: true,
    },
    {
      label: "2020 magti",
      url: "data/magti2020.txt.gz",
      gzipped: true,
    },
  ];

  const USE_JSDELIVR = false;
  const GITHUB_USER = "node6972-debug";
  const GITHUB_REPO = "Georgian-osint";
  const GITHUB_REF  = "main";
  // -----------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const qEl = $("q"), ageMinEl = $("age-min"), ageMaxEl = $("age-max");
  const sexEl = $("sex"), sourceEl = $("source"), sortEl = $("sort");
  const listEl = $("list"), countEl = $("count"), statsEl = $("stats");
  const pagerTop = $("pager-top"), pagerBottom = $("pager-bottom");
  const cardTpl = $("card-tpl");
  const bootEl = $("boot"), bootFill = $("boot-fill"), bootDetail = $("boot-detail");

  const state = {
    page: 1, perPage: 50, terms: [], total: 0, pages: 1,
    ready: false, requestId: 0, inflightRequestId: 0,
  };

  // Relative path — resolves correctly under /repo/ on GitHub Pages.
  const worker = new Worker("worker.js");

  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function highlight(text) {
    if (text == null) return "";
    const raw = String(text);
    if (!state.terms.length) return esc(raw);
    const re = new RegExp("(" + state.terms.map(escRe).join("|") + ")", "gi");
    let out = "", last = 0;
    raw.replace(re, (m, _g, i) => {
      out += esc(raw.slice(last, i)) + "<mark>" + esc(m) + "</mark>";
      last = i + m.length;
      return m;
    });
    return out + esc(raw.slice(last));
  }

  const initials = (a, b) => {
    const x = (a || "").trim(), y = (b || "").trim();
    const first = x ? x[0] : (y ? y[0] : "?");
    const second = y ? y[0] : (x.length > 1 ? x[1] : "");
    return (first + second).toUpperCase();
  };

  function avatarHue(str) {
    let h = 0;
    for (let i = 0; i < (str || "").length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  function resolveUrl(u) {
    if (/^https?:\/\//i.test(u)) return u;
    if (!USE_JSDELIVR) return u;
    return `https://cdn.jsdelivr.net/gh/${GITHUB_USER}/${GITHUB_REPO}@${GITHUB_REF}/${u.replace(/^\/+/, "")}`;
  }

  // ---------- boot ----------
  function boot() {
    const sources = SOURCE_URLS.map((s) => ({ ...s, url: resolveUrl(s.url) }));

    sourceEl.innerHTML = `<option value="">All sources</option>` +
      sources.map((s) => `<option value="${esc(s.label)}">${esc(s.label)}</option>`).join("");

    worker.postMessage({ type: "load", sources });
  }

  worker.onmessage = (e) => {
    const m = e.data;

    if (m.type === "progress") {
      bootFill.style.width = Math.round(m.p * 100) + "%";
      bootDetail.textContent = `${m.label}… ${Math.round(m.p * 100)}%`;
    }
    else if (m.type === "loaded") {
      statsEl.textContent = `${fmt(m.count)} records`;
      bootEl.classList.add("done");
      state.ready = true;
      run();
    }
    else if (m.type === "results") {
      if (m.requestId !== state.inflightRequestId) return;
      render(m);
    }
    else if (m.type === "error") {
      bootDetail.textContent = "Error: " + m.message;
    }
  };

  // ---------- query ----------
  const numOrNull = (el) => {
    const v = el.value.trim();
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };

  function run() {
    if (!state.ready) return;
    const requestId = ++state.requestId;
    state.inflightRequestId = requestId;
    listEl.innerHTML = `<div class="empty">Searching…</div>`;
    worker.postMessage({
      type: "search",
      requestId,
      query: {
        q: qEl.value,
        ageMin: numOrNull(ageMinEl),
        ageMax: numOrNull(ageMaxEl),
        sex: sexEl.value || null,
        source: sourceEl.value || null,
        sort: sortEl.value || "",
        page: state.page,
        perPage: state.perPage,
      },
    });
  }

  // ---------- render ----------
  function render(data) {
    state.terms = data.terms || [];
    state.total = data.total;
    state.pages = Math.max(1, Math.ceil(data.total / data.perPage));

    if (!data.results.length) {
      listEl.innerHTML = `<div class="empty">No records match your search.</div>`;
      countEl.textContent = "0 records";
      pagerTop.innerHTML = ""; pagerBottom.innerHTML = "";
      return;
    }

    const from = (data.page - 1) * data.perPage + 1;
    const to = Math.min(data.page * data.perPage, data.total);
    countEl.textContent = `${fmt(from)}–${fmt(to)} of ${fmt(data.total)}`;

    listEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const r of data.results) frag.appendChild(renderCard(r));
    listEl.appendChild(frag);

    renderPager(pagerTop, data.page, state.pages);
    renderPager(pagerBottom, data.page, state.pages);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderCard(r) {
    const node = cardTpl.content.firstElementChild.cloneNode(true);
    const av = node.querySelector(".avatar");
    av.querySelector("span").textContent = initials(r.fn, r.ln);
    const hue = avatarHue(r.ln || r.fn || "");
    av.style.background = `hsl(${hue} 70% 92%)`;
    av.style.color = `hsl(${hue} 55% 32%)`;

    const nameParts = [r.fn, r.ln].filter(Boolean);
    node.querySelector(".name").innerHTML =
      nameParts.length ? nameParts.map(highlight).join(" ") : "<em>Unnamed record</em>";

    const src = node.querySelector(".src");
    if (r.src) src.textContent = r.src; else src.style.display = "none";

    const meta = [];
    if (r.father) meta.push(`<span><span class="k">Father</span> <b>${highlight(r.father)}</b></span>`);
    if (r.id) meta.push(`<span><span class="k">ID</span> <b>${highlight(r.id)}</b></span>`);
    if (r.dob) {
      const age = r.by ? (new Date().getFullYear() - r.by) : null;
      const tail = age != null ? ` <span class="k">(${age})</span>` : "";
      meta.push(`<span><span class="k">DOB</span> <b>${highlight(r.dob)}</b>${tail}</span>`);
    }
    if (r.sex) meta.push(`<span><span class="k">Sex</span> <b>${r.sex === "M" ? "Male" : "Female"}</b></span>`);
    if (r.mob) meta.push(`<span><span class="k">Mobile</span> <b>${highlight(r.mob)}</b></span>`);
    node.querySelector(".meta").innerHTML = meta.join("");

    node.querySelector(".address").innerHTML = r.addr
      ? `<span class="k" style="color:var(--muted)">Address</span> ${highlight(r.addr)}`
      : "";

    const extraEl = node.querySelector(".extra");
    const lines = [];
    if (Array.isArray(r.extra) && r.extra.length) lines.push("Unmapped: " + r.extra.join(" · "));
    extraEl.textContent = lines.join("\n");
    if (!lines.length) node.querySelector(".expand").style.display = "none";

    node.querySelector(".expand").addEventListener("click", () => node.classList.toggle("open"));
    return node;
  }

  function renderPager(el, page, pages) {
    el.innerHTML = "";
    if (pages <= 1) return;
    const mk = (label, p, disabled) => {
      const b = document.createElement("button");
      b.textContent = label; b.disabled = disabled;
      b.addEventListener("click", () => { state.page = Math.max(1, p); run(); });
      return b;
    };
    el.appendChild(mk("‹ Prev", page - 1, page <= 1));
    const info = document.createElement("span");
    info.className = "page-info";
    info.textContent = `Page ${page} of ${pages}`;
    el.appendChild(info);
    el.appendChild(mk("Next ›", page + 1, page >= pages));
  }

  // ---------- events ----------
  let debounce;
  qEl.addEventListener("input", () => {
    clearTimeout(debounce);
    state.page = 1;
    debounce = setTimeout(run, 220);
  });
  for (const el of [sexEl, sourceEl, sortEl]) {
    el.addEventListener("change", () => { state.page = 1; run(); });
  }
  for (const el of [ageMinEl, ageMaxEl]) {
    el.addEventListener("input", () => {
      clearTimeout(debounce);
      state.page = 1;
      debounce = setTimeout(run, 320);
    });
  }
  $("clear").addEventListener("click", () => {
    qEl.value = ""; ageMinEl.value = ""; ageMaxEl.value = "";
    sexEl.value = ""; sourceEl.value = ""; sortEl.value = "";
    state.page = 1; run();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.activeElement !== qEl) {
      qEl.focus(); qEl.select();
    }
  });

  boot();
})();