/**
 * Gene Key Search — NCBI PubMed + PMC full-text + Unpaywall integration
 */

const EUTILS_BASE    = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const UNPAYWALL_BASE = 'https://api.unpaywall.org/v2/';

// ─── Gene chip preview ────────────────────────────────────────────────────────
document.getElementById('genes').addEventListener('input', renderGeneChips);

function renderGeneChips() {
  const genes = parseGenes(document.getElementById('genes').value);
  document.getElementById('gene-chips').innerHTML = genes
    .map(g => `<span class="chip">${escHtml(g)}</span>`).join('');
}

function parseGenes(raw) {
  return raw.split(/[,\n]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
}

// ─── Main search ──────────────────────────────────────────────────────────────
async function runSearch() {
  const genesRaw = document.getElementById('genes').value.trim();
  const keywords = document.getElementById('keywords').value.trim();
  if (!genesRaw && !keywords) { showError('Please enter at least one gene name or keyword.'); return; }

  const genes      = parseGenes(genesRaw);
  const maxResults = Math.min(Math.max(parseInt(document.getElementById('max-results').value) || 20, 1), 200);
  const sortBy     = document.getElementById('sort-by').value;
  const afterYear  = parseInt(document.getElementById('date-filter').value) || null;
  const apiKey     = document.getElementById('api-key').value.trim();
  const email      = document.getElementById('unpaywall-email').value.trim();

  clearError();
  setLoading(true);
  setStatus('Building query…');
  document.getElementById('results').style.display = 'none';
  document.getElementById('neighborhood-panel').style.display = 'none';

  try {
    const genePart = genes.length
      ? genes.map(g => `"${g}"[Gene Name] OR "${g}"[Title/Abstract]`).join(' OR ')
      : '';
    const kwPart = keywords
      ? keywords.split(/[,\n]+/).map(k => `"${k.trim()}"[Title/Abstract]`).join(' AND ')
      : '';
    let query = [genePart, kwPart].filter(Boolean).join(' AND ');
    if (afterYear) query += ` AND ("${afterYear}/01/01"[Date - Publication] : "3000"[Date - Publication])`;

    setStatus(`Searching PubMed…`);

    // Step 1: esearch → PMIDs
    const searchRes = await fetchJson(buildUrl('esearch.fcgi', {
      db: 'pubmed', term: query, retmax: maxResults, sort: sortBy,
      retmode: 'json', usehistory: 'y', ...(apiKey && { api_key: apiKey }),
    }));
    const { idlist, count } = searchRes.esearchresult;
    if (!idlist || idlist.length === 0) {
      setStatus(''); showError('No results found. Try broader gene names or keywords.');
      setLoading(false); return;
    }

    setStatus(`Found ${count} results. Fetching metadata…`);

    // Step 2: esummary → metadata (includes PMC IDs in articleids)
    const summaryRes = await fetchJson(buildUrl('esummary.fcgi', {
      db: 'pubmed', id: idlist.join(','), retmode: 'json',
      ...(apiKey && { api_key: apiKey }),
    }));
    const papers = parseSummaries(summaryRes.result, idlist);

    // Step 3: abstracts
    setStatus('Fetching abstracts…');
    const abstracts = await fetchAbstracts(idlist, apiKey);
    papers.forEach(p => { p.abstract = abstracts[p.pmid] || ''; });

    setStatus('');
    setLoading(false);
    renderResults(papers, parseInt(count));

    // Step 4 (background): gene descriptions for queried genes
    if (genes.length) showGeneDescriptions(genes, papers, apiKey);

    // Step 5 (background): Unpaywall for papers with DOIs
    if (email) {
      enrichWithUnpaywall(papers, email);
    }

    // Step 5 (background): Gene neighborhood analysis
    runNeighborhoodAnalysis(idlist, genes, apiKey);

  } catch (err) {
    setLoading(false); setStatus('');
    showError(`Error: ${err.message}. Check your network connection or API key.`);
    console.error(err);
  }
}

// ─── NCBI helpers ─────────────────────────────────────────────────────────────
function buildUrl(endpoint, params) {
  const url = new URL(EUTILS_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from NCBI`);
  return res.json();
}

async function fetchAbstracts(pmids, apiKey) {
  const url = buildUrl('efetch.fcgi', {
    db: 'pubmed', id: pmids.join(','), rettype: 'abstract', retmode: 'text',
    ...(apiKey && { api_key: apiKey }),
  });
  const res = await fetch(url);
  if (!res.ok) return {};
  return parseAbstractText(await res.text());
}

function parseAbstractText(text) {
  const map = {};
  text.split(/\n\n\n+/).forEach(block => {
    const pmidMatch = block.match(/PMID:\s*(\d+)/);
    if (!pmidMatch) return;
    const absMatch = block.match(/Abstract\s*\n([\s\S]+?)(?:\n(?:Author information|PMID|Copyright|DOI|Comment|Conflict|ClinicalTrials|Erratum|Supplementary|©|\d{4} ))/i);
    map[pmidMatch[1]] = absMatch ? absMatch[1].replace(/\s+/g, ' ').trim() : '';
  });
  return map;
}

function parseSummaries(result, idlist) {
  return idlist.map(pmid => {
    const art = result[pmid];
    if (!art) return null;

    const authors   = (art.authors || []).map(a => a.name);
    const authorStr = authors.length > 3 ? `${authors.slice(0, 3).join(', ')}, et al.` : authors.join(', ');
    const pubDate   = art.pubdate || art.epubdate || '';
    const year      = pubDate.match(/\d{4}/)?.[0] || '';
    const journal   = art.fulljournalname || art.source || '';
    const volume    = art.volume || '';
    const issue     = art.issue  ? `(${art.issue})` : '';
    const pages     = art.pages  ? `:${art.pages}` : '';
    const ids       = art.articleids || [];
    const doi       = ids.find(i => i.idtype === 'doi')?.value  || '';
    // PMC ID comes as "PMC1234567" or just digits — normalise to numeric
    const pmcRaw    = ids.find(i => i.idtype === 'pmc')?.value  || '';
    const pmcid     = pmcRaw.replace(/^PMC/i, '').trim();

    const citation = [
      authorStr,
      year ? ` (${year}).` : '.',
      ` ${art.title}`,
      journal ? ` ${journal}` : '',
      volume  ? `, ${volume}${issue}${pages}` : '',
      doi     ? `. https://doi.org/${doi}` : '',
      `. PMID: ${pmid}`,
      pmcid   ? `. PMCID: PMC${pmcid}` : '',
    ].join('');

    return { pmid, title: art.title, authors: authorStr, year, journal, volume, issue, pages, doi, pmcid, pubDate, citation };
  }).filter(Boolean);
}

// ─── PMC Full Text ────────────────────────────────────────────────────────────
async function loadFullText(pmcid, idx) {
  const btn = document.getElementById(`ft-btn-${idx}`);
  const box = document.getElementById(`ft-box-${idx}`);
  const apiKey = document.getElementById('api-key').value.trim();

  btn.disabled = true;
  btn.textContent = 'Loading full text…';

  try {
    const url = buildUrl('efetch.fcgi', {
      db: 'pmc', id: pmcid, rettype: 'full', retmode: 'xml',
      ...(apiKey && { api_key: apiKey }),
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xmlText = await res.text();
    const sections = parsePmcXml(xmlText);

    if (!sections.length) {
      box.innerHTML = '<p style="color:#8b949e;font-size:0.85rem">Full text not available in this format.</p>';
    } else {
      box.innerHTML = sections.map(s => `
        ${s.title ? `<h4 class="ft-section-title">${escHtml(s.title)}</h4>` : ''}
        <p class="ft-section-body">${escHtml(s.text)}</p>
      `).join('');
    }

    box.style.display = 'block';
    btn.textContent = 'Hide full text ▴';
    btn.disabled = false;
    btn.onclick = () => toggleFullText(idx);

  } catch (err) {
    box.innerHTML = `<p style="color:#f85149;font-size:0.85rem">Could not load full text: ${escHtml(err.message)}</p>`;
    box.style.display = 'block';
    btn.textContent = 'Full text (PMC)';
    btn.disabled = false;
  }
}

function toggleFullText(idx) {
  const btn = document.getElementById(`ft-btn-${idx}`);
  const box = document.getElementById(`ft-box-${idx}`);
  if (box.style.display === 'none') {
    box.style.display = 'block';
    btn.textContent = 'Hide full text ▴';
  } else {
    box.style.display = 'none';
    btn.textContent = 'Show full text ▾';
  }
}

function parsePmcXml(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'application/xml');
  const body   = doc.querySelector('body');
  if (!body) return [];

  const sections = [];
  body.querySelectorAll('sec').forEach(sec => {
    // Only top-level sections (direct children of body or first-level)
    if (sec.parentElement && sec.parentElement.tagName.toLowerCase() !== 'body') return;
    const titleEl = sec.querySelector(':scope > title');
    const title   = titleEl ? titleEl.textContent.trim() : '';
    const paras   = [...sec.querySelectorAll(':scope > p')].map(p => p.textContent.trim()).filter(Boolean);
    if (paras.length) sections.push({ title, text: paras.join('\n\n') });
  });

  // Fallback: if no sec structure, grab all top-level paragraphs
  if (!sections.length) {
    const paras = [...body.querySelectorAll('p')].map(p => p.textContent.trim()).filter(Boolean);
    if (paras.length) sections.push({ title: '', text: paras.join('\n\n') });
  }

  return sections;
}

// ─── Unpaywall (background enrichment) ───────────────────────────────────────
async function enrichWithUnpaywall(papers, email) {
  const withDoi = papers.filter(p => p.doi);
  if (!withDoi.length) return;

  // Stagger requests to be polite (~5/sec)
  const results = await Promise.allSettled(
    withDoi.map((p, i) => new Promise(resolve =>
      setTimeout(() => fetchUnpaywall(p.doi, email).then(resolve).catch(() => resolve(null)), i * 200)
    ))
  );

  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value) return;
    const paper = withDoi[i];
    const data  = r.value;
    const idx   = papers.indexOf(paper);
    updateCardWithUnpaywall(idx, data);
    paper.oaData = data;
  });
}

async function fetchUnpaywall(doi, email) {
  const url = `${UNPAYWALL_BASE}${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function updateCardWithUnpaywall(idx, data) {
  const oaLoc = data.best_oa_location;
  if (!oaLoc) return;

  const pdfUrl = oaLoc.url_for_pdf || oaLoc.url;
  if (!pdfUrl) return;

  const anchor = document.getElementById(`oa-slot-${idx}`);
  if (!anchor) return;

  const label = oaLoc.url_for_pdf ? 'Free PDF' : 'Free Full Text';
  const color = data.oa_status === 'gold' ? '#f0883e' : data.oa_status === 'green' ? '#3fb950' : '#58a6ff';
  anchor.innerHTML = `
    <a href="${escHtml(pdfUrl)}" target="_blank" rel="noopener"
       style="background:rgba(63,185,80,0.12);border:1px solid ${color};color:${color};
              font-size:0.74rem;padding:2px 10px;border-radius:20px;text-decoration:none;font-weight:600;">
      &#x1F513; ${label}
    </a>`;
}

// ─── Gene Neighborhood Analysis ───────────────────────────────────────────────
// Non-gene uppercase tokens to ignore when scanning abstracts
const NBR_BLOCKLIST = new Set([
  'RNA','DNA','PCR','MRNA','CDNA','RRNA','TRNA','NCRNA','LNCRNA','SNRNA',
  'ATP','ADP','GTP','GDP','AMP','NAD','FAD','CAMP','CGMP','NADH','FADH',
  'USA','FDA','WHO','NIH','NCI','CDC','EMA','ICH','ASCO','ESMO','NCCN',
  'MRI','CT','PET','ECG','EEG','EMG','LDH','ALT','AST','PSA','CEA','CA',
  'SDS','PAGE','FISH','FACS','ELISA','CHIP','WB','RT','IHC','ICC','IF','IP',
  'IC','IV','VI','VII','VIII','IX','XI','XII','OS','HR','CI','OR','RR',
  'SD','SE','SEM','KO','WT','OE','KD','CKO','DKO','TKO','SKO',
  'IL','INF','IFN','TNF','TGF','EGF','IGF','NGF','VEGF','PDGF','FGF',
  'BDNF','CSF','EPO','TPO','SCF','BMP','WNT','SHH','NF','AP','HIF',
  'MHC','HLA','TCR','BCR','CAR','NK','DC','LN','PD',
  'CRC','HCC','GBM','NSCLC','SCLC','AML','CML','ALL','CLL','MM','NHL',
  'PBS','DMSO','EDTA','BSA','FBS','DMEM','RPMI','LPS','LPA',
  'PFS','DFS','RFS','TTR','ORR','DCR','CR','PR','SD','PD',
  'ACE','ARB','SSRI','NSAID','PPI','XRT',
  'COVID','SARS','HIV','HPV','HCV','HBV','EBV','CMV','HSV',
  'ER','PR','AR','GR','TR','PXR','CAR','RXR','LXR','FXR',
  'IC50','EC50','KD','KI','KM','PK','PD','ADME','QC','QA',
  'CDS','UTR','ORF','SNP','CNV','LOH','MSI','TMB','PDL',
]);

async function runNeighborhoodAnalysis(pmids, searchedGenes, apiKey) {
  const panel = document.getElementById('neighborhood-panel');
  panel.style.display = 'block';

  const papers = window._papers || [];

  // Fetch full text for PMC papers that haven't been loaded yet
  const pmcPapers = papers.filter(p => p.pmcid && !p.fullTextContent);
  if (pmcPapers.length) {
    panel.innerHTML = `<p class="nbr-loading">&#x1F9EC; Fetching full text for ${pmcPapers.length} open-access paper(s)…</p>`;
    const delay = apiKey ? 110 : 350;   // respect NCBI rate limits
    for (let i = 0; i < pmcPapers.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, delay));
      try {
        pmcPapers[i].fullTextContent = await fetchFullTextContent(pmcPapers[i].pmcid, apiKey);
      } catch { /* leave undefined; fall back to abstract */ }
    }
  }

  panel.innerHTML = '<p class="nbr-loading">&#x1F9EC; Analyzing gene neighborhood…</p>';

  // Pull candidates from full text (PMC) or abstract (fallback)
  const candidates = extractCandidates(papers, searchedGenes);

  if (!candidates.length) {
    panel.innerHTML = '<p class="nbr-empty">Not enough co-mentioned genes found in these abstracts.</p>';
    return;
  }

  // Validate top 40 candidates against NCBI Gene (human only) — 2 API calls
  try {
    const validated = await validateAgainstNCBI(candidates.slice(0, 40), apiKey);
    renderNeighborhood(validated);
  } catch (e) {
    // Fallback: show unvalidated candidates with a note
    renderNeighborhood(candidates.slice(0, 30).map(c => ({ ...c, name: '' })));
  }
}

// Fetch PMC full text and return concatenated plain text (all section bodies)
async function fetchFullTextContent(pmcid, apiKey) {
  const url = buildUrl('efetch.fcgi', {
    db: 'pmc', id: pmcid, rettype: 'full', retmode: 'xml',
    ...(apiKey && { api_key: apiKey }),
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const sections = parsePmcXml(await res.text());
  return sections.map(s => (s.title ? s.title + '\n' : '') + s.text).join('\n\n');
}

// Scan titles + full text (or abstract) for gene-symbol-like tokens, tally per-paper frequency
function extractCandidates(papers, searchedGenes) {
  const searchedUpper = new Set(searchedGenes.map(g => g.toUpperCase()));
  const freq = {};

  papers.forEach(p => {
    // Prefer full text when available (PMC open-access), otherwise fall back to abstract
    const body = p.fullTextContent || p.abstract || '';
    const text = (p.title || '') + ' ' + body;
    const seen = new Set();
    // Gene symbols: 2–8 chars, start with letter, uppercase letters/digits, no leading digits
    const matches = text.match(/\b[A-Z][A-Z0-9]{1,7}\b/g) || [];
    matches.forEach(sym => {
      if (NBR_BLOCKLIST.has(sym)) return;
      if (searchedUpper.has(sym)) return;
      // Skip pure roman-numeral-like tokens and very short tokens
      if (/^(I{1,4}|II|III|IV|VI{0,3}|IX|XI{0,3})$/.test(sym)) return;
      if (!seen.has(sym)) {
        seen.add(sym);
        freq[sym] = (freq[sym] || 0) + 1;
      }
    });
  });

  return Object.entries(freq)
    .filter(([, count]) => count >= 2)        // must appear in ≥2 papers
    .sort((a, b) => b[1] - a[1])
    .map(([symbol, count]) => ({ symbol, count }));
}

// Batch-validate candidates against NCBI Gene database (human, taxid 9606)
async function validateAgainstNCBI(candidates, apiKey) {
  if (!candidates.length) return [];
  const termParts = candidates.map(c => `"${c.symbol}"[Gene Name]`).join(' OR ');
  const searchUrl = buildUrl('esearch.fcgi', {
    db: 'gene',
    term: `(${termParts}) AND 9606[Taxonomy ID]`,
    retmax: 50,
    retmode: 'json',
    ...(apiKey && { api_key: apiKey }),
  });
  const searchRes = await fetchJson(searchUrl);
  const ids = searchRes.esearchresult?.idlist || [];
  if (!ids.length) return [];

  const summaryUrl = buildUrl('esummary.fcgi', {
    db: 'gene', id: ids.join(','), retmode: 'json',
    ...(apiKey && { api_key: apiKey }),
  });
  const summaryRes = await fetchJson(summaryUrl);
  const result = summaryRes.result || {};

  // Map official symbol → {name, chromosome}
  const officialMap = {};
  ids.forEach(id => {
    const g = result[id];
    if (!g || !g.name) return;
    if (String(g.organism?.taxid) !== '9606') return;
    officialMap[g.name.toUpperCase()] = {
      symbol: g.name,
      name: g.description || '',
      chromosome: g.chromosome || '',
    };
  });

  // Merge frequencies back in, preserving original sort order
  return candidates
    .map(c => {
      const info = officialMap[c.symbol.toUpperCase()];
      return info ? { ...c, ...info } : null;
    })
    .filter(Boolean)
    .slice(0, 35);
}

function renderNeighborhood(neighbors, searchedGenes) {
  const panel = document.getElementById('neighborhood-panel');
  if (!neighbors.length) {
    panel.innerHTML = '<p class="nbr-empty">No neighboring genes found in these papers.</p>';
    return;
  }

  const maxCount = neighbors[0].count;
  const chips = neighbors.map(g => {
    const bar = Math.round((g.count / maxCount) * 100);
    return `
      <button class="nbr-chip" title="${escHtml(g.name)}${g.chromosome ? ' · chr' + escHtml(g.chromosome) : ''}"
              onclick="addNeighborGene('${escHtml(g.symbol)}')">
        <span class="nbr-symbol">${escHtml(g.symbol)}</span>
        <span class="nbr-count">${g.count}</span>
        <span class="nbr-bar" style="width:${bar}%"></span>
      </button>`;
  }).join('');

  panel.innerHTML = `
    <div class="nbr-header">
      <span class="nbr-title">&#x1F9EC; Gene Neighborhood</span>
      <span class="nbr-subtitle">Genes co-mentioned in these papers &mdash; click to add to search</span>
    </div>
    <div class="nbr-chips">${chips}</div>
    <p class="nbr-note">Sorted by co-mention frequency &middot; human genes only &middot; excludes queried genes</p>
  `;
}

function addNeighborGene(symbol) {
  const el = document.getElementById('genes');
  const existing = parseGenes(el.value).map(g => g.toUpperCase());
  if (existing.includes(symbol.toUpperCase())) return;
  el.value = el.value.trim() ? el.value.trim() + ', ' + symbol : symbol;
  renderGeneChips();
  // briefly flash the gene input
  el.style.borderColor = '#3fb950';
  setTimeout(() => { el.style.borderColor = ''; }, 900);
}

// ─── Render results ───────────────────────────────────────────────────────────
function renderResults(papers, totalCount) {
  document.getElementById('result-count').textContent = `${papers.length} of ${totalCount} papers`;
  document.getElementById('results').style.display = 'block';

  const container = document.getElementById('papers');
  container.innerHTML = '';

  papers.forEach((p, idx) => {
    const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`;
    const hasPmc    = !!p.pmcid;
    const hasAbstract = p.abstract && p.abstract.length > 0;

    const card = document.createElement('div');
    card.className = 'paper-card';
    card.innerHTML = `
      <div class="paper-title">
        <a href="${pubmedUrl}" target="_blank" rel="noopener">${escHtml(p.title)}</a>
      </div>
      <div class="paper-meta">
        <span>${escHtml(p.authors)}</span>
        ${p.year    ? `<span class="tag">${p.year}</span>` : ''}
        ${p.journal ? `<span class="tag">${escHtml(p.journal)}</span>` : ''}
        ${hasPmc    ? `<span class="tag tag-pmc">PMC Open Access</span>` : ''}
        ${p.doi     ? `<a href="https://doi.org/${p.doi}" target="_blank" rel="noopener" style="color:#58a6ff;font-size:0.78rem">DOI</a>` : ''}
        <a href="${pubmedUrl}" target="_blank" rel="noopener" style="color:#8b949e;font-size:0.78rem">PMID ${p.pmid}</a>
        <span id="oa-slot-${idx}"></span>
      </div>

      ${hasAbstract ? `
        <div class="paper-abstract collapsed" id="abs-${idx}">${escHtml(p.abstract)}</div>
        <button class="toggle-abstract" onclick="toggleAbstract(${idx})">Show abstract ▾</button>
      ` : `<p style="font-size:0.82rem;color:#484f58;margin-bottom:10px">No abstract available</p>`}

      ${hasPmc ? `
        <div class="ft-actions">
          <button class="btn-ft" id="ft-btn-${idx}" onclick="loadFullText('${p.pmcid}', ${idx})">
            &#x1F4C4; Load full text (PMC)
          </button>
        </div>
        <div class="ft-box" id="ft-box-${idx}" style="display:none"></div>
      ` : ''}

      <div class="citation-box">
        <span class="citation-text" id="cit-${idx}">${escHtml(p.citation)}</span>
        <button class="btn-copy" onclick="copyCitation(${idx})">Copy</button>
      </div>
    `;
    container.appendChild(card);
  });

  window._papers = papers;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function toggleAbstract(idx) {
  const el  = document.getElementById(`abs-${idx}`);
  const btn = el.nextElementSibling;
  const collapsed = el.classList.toggle('collapsed');
  btn.textContent = collapsed ? 'Show abstract ▾' : 'Hide abstract ▴';
}

function copyCitation(idx) {
  const text = document.getElementById(`cit-${idx}`).textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector(`[onclick="copyCitation(${idx})"]`);
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
  });
}

function exportResults() {
  const papers = window._papers || [];
  if (!papers.length) return;
  const lines = papers.map((p, i) => {
    let line = `[${i + 1}] ${p.citation}`;
    if (p.oaData?.best_oa_location?.url_for_pdf) line += `\n    Free PDF: ${p.oaData.best_oa_location.url_for_pdf}`;
    return line;
  });
  const blob = new Blob([lines.join('\n\n')], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'gene_search_citations.txt';
  a.click();
}

function setLoading(on) {
  document.getElementById('search-btn').disabled = on;
  document.getElementById('spinner').style.display    = on ? 'block' : 'none';
  document.getElementById('search-icon').style.display = on ? 'none' : 'block';
}

function setStatus(msg) { document.getElementById('status').textContent = msg; }

function showError(msg) {
  const box = document.getElementById('error-box');
  box.textContent = msg; box.style.display = 'block';
}

function clearError() {
  const box = document.getElementById('error-box');
  box.textContent = ''; box.style.display = 'none';
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

['genes', 'keywords'].forEach(id =>
  document.getElementById(id).addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runSearch();
  })
);

// ─── Gene descriptions ────────────────────────────────────────────────────────
async function showGeneDescriptions(genes, papers, apiKey) {
  const panel = document.getElementById('gene-desc-panel');
  panel.style.display = 'block';
  panel.innerHTML = '<p style="padding:6px 0;font-size:0.8rem;color:#8b949e">&#x1F9EC; Loading gene summaries…</p>';

  // Fetch NCBI Gene descriptions for all queried genes (2 API calls)
  const infoMap = await fetchGeneInfo(genes, apiKey).catch(() => ({}));

  const cards = genes.map(sym => {
    const info = infoMap[sym.toUpperCase()] || {};
    const ctx  = pickContextSentence(sym, papers);
    return `
      <div class="gdesc-card">
        <div class="gdesc-top">
          <span class="gdesc-sym">${escHtml(sym)}</span>
          ${info.chromosome ? `<span class="gdesc-chr">chr${escHtml(info.chromosome)}</span>` : ''}
        </div>
        ${info.name ? `<div class="gdesc-name">${escHtml(info.name)}</div>` : ''}
        ${ctx       ? `<div class="gdesc-ctx">${escHtml(ctx)}</div>`        : ''}
      </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="gdesc-header">
      <span class="gdesc-title">&#x1F50D; Genes of Interest</span>
      <span class="gdesc-sub">NCBI description &amp; context from retrieved papers</span>
    </div>
    <div class="gdesc-cards">${cards}</div>`;
}

async function fetchGeneInfo(symbols, apiKey) {
  const term = symbols.map(s => `"${s}"[Gene Name]`).join(' OR ');
  const sRes = await fetchJson(buildUrl('esearch.fcgi', {
    db: 'gene', term: `(${term}) AND 9606[Taxonomy ID]`,
    retmax: symbols.length + 5, retmode: 'json',
    ...(apiKey && { api_key: apiKey }),
  }));
  const ids = sRes.esearchresult?.idlist || [];
  if (!ids.length) return {};

  const dRes = await fetchJson(buildUrl('esummary.fcgi', {
    db: 'gene', id: ids.join(','), retmode: 'json',
    ...(apiKey && { api_key: apiKey }),
  }));
  const map = {};
  (dRes.result?.uids || ids).forEach(id => {
    const g = dRes.result?.[id];
    if (!g?.name || String(g.organism?.taxid) !== '9606') return;
    map[g.name.toUpperCase()] = { name: g.description || '', chromosome: g.chromosome || '' };
  });
  return map;
}

// Pick the first clean sentence from any paper's abstract that mentions `sym`
function pickContextSentence(sym, papers) {
  const re = new RegExp(`\\b${sym}\\b`);
  for (const p of papers) {
    const text = p.abstract || '';
    const sentences = text.replace(/([.!?])\s+/g, '$1\n').split('\n');
    for (const raw of sentences) {
      const s = raw.trim();
      if (!re.test(s) || s.length < 40 || s.length > 350 || !/^[A-Za-z]/.test(s)) continue;
      return s.length > 150 ? s.slice(0, 147) + '…' : s;
    }
  }
  return '';
}
