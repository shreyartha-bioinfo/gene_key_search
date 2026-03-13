/**
 * Gene Key Search — NCBI PubMed integration
 * Uses NCBI E-utilities (esearch + esummary + efetch) — no server required.
 */

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';

// ─── Chip preview for gene input ─────────────────────────────────────────────
document.getElementById('genes').addEventListener('input', renderGeneChips);

function renderGeneChips() {
  const raw = document.getElementById('genes').value;
  const genes = parseGenes(raw);
  const container = document.getElementById('gene-chips');
  container.innerHTML = genes
    .map(g => `<span class="chip">${escHtml(g)}</span>`)
    .join('');
}

function parseGenes(raw) {
  return raw
    .split(/[,\n]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}

// ─── Main search entry point ──────────────────────────────────────────────────
async function runSearch() {
  const genesRaw  = document.getElementById('genes').value.trim();
  const keywords  = document.getElementById('keywords').value.trim();

  if (!genesRaw && !keywords) {
    showError('Please enter at least one gene name or keyword.');
    return;
  }

  const genes      = parseGenes(genesRaw);
  const maxResults = Math.min(Math.max(parseInt(document.getElementById('max-results').value) || 20, 1), 200);
  const sortBy     = document.getElementById('sort-by').value;
  const afterYear  = parseInt(document.getElementById('date-filter').value) || null;
  const apiKey     = document.getElementById('api-key').value.trim();

  clearError();
  setLoading(true);
  setStatus('Building query…');
  document.getElementById('results').style.display = 'none';

  try {
    // Build query: each gene as [Gene Name] field tag + free-text keywords
    const genePart = genes.length
      ? genes.map(g => `"${g}"[Gene Name] OR "${g}"[Title/Abstract]`).join(' OR ')
      : '';
    const kwPart = keywords
      ? keywords.split(/[,\n]+/).map(k => `"${k.trim()}"[Title/Abstract]`).join(' AND ')
      : '';

    let query = [genePart, kwPart].filter(Boolean).join(' AND ');
    if (afterYear) query += ` AND ("${afterYear}/01/01"[Date - Publication] : "3000"[Date - Publication])`;

    setStatus(`Searching PubMed for: ${query.substring(0, 120)}…`);

    // Step 1: esearch → get PMIDs
    const searchUrl = buildUrl('esearch.fcgi', {
      db: 'pubmed',
      term: query,
      retmax: maxResults,
      sort: sortBy,
      retmode: 'json',
      usehistory: 'y',
      ...(apiKey && { api_key: apiKey }),
    });

    const searchRes = await fetchJson(searchUrl);
    const { idlist, count, webenv, query_key } = searchRes.esearchresult;

    if (!idlist || idlist.length === 0) {
      setStatus('');
      showError(`No results found for your query. Try broader gene names or keywords.`);
      setLoading(false);
      return;
    }

    setStatus(`Found ${count} total results. Fetching details for top ${idlist.length}…`);

    // Step 2: esummary → article metadata
    const summaryUrl = buildUrl('esummary.fcgi', {
      db: 'pubmed',
      id: idlist.join(','),
      retmode: 'json',
      ...(apiKey && { api_key: apiKey }),
    });

    const summaryRes = await fetchJson(summaryUrl);
    const papers = parseSummaries(summaryRes.result, idlist);

    // Step 3: efetch abstracts in one request (text mode)
    setStatus('Fetching abstracts…');
    const abstracts = await fetchAbstracts(idlist, apiKey);

    // Merge abstracts
    papers.forEach(p => {
      p.abstract = abstracts[p.pmid] || '';
    });

    setStatus('');
    setLoading(false);
    renderResults(papers, parseInt(count), genes, keywords);

  } catch (err) {
    setLoading(false);
    setStatus('');
    showError(`Error: ${err.message}. Check your network connection or NCBI API key.`);
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
  const params = {
    db: 'pubmed',
    id: pmids.join(','),
    rettype: 'abstract',
    retmode: 'text',
    ...(apiKey && { api_key: apiKey }),
  };
  const url = buildUrl('efetch.fcgi', params);
  const res = await fetch(url);
  if (!res.ok) return {};
  const text = await res.text();
  return parseAbstractText(text, pmids);
}

// Parse the plain-text efetch response; sections are separated by blank lines + PMID header
function parseAbstractText(text, pmids) {
  const map = {};
  // Each record starts with "1. Title\n\nAuthor...\nPMID: XXXXX"
  const records = text.split(/\n\n\n+/);
  records.forEach(block => {
    const pmidMatch = block.match(/PMID:\s*(\d+)/);
    if (!pmidMatch) return;
    const pmid = pmidMatch[1];
    // Abstract is the paragraph that follows "Abstract" header
    const absMatch = block.match(/Abstract\s*\n([\s\S]+?)(?:\n(?:Author information|PMID|Copyright|DOI|Comment|Conflict|ClinicalTrials|Erratum|Supplementary|©|\d{4} ))/i);
    map[pmid] = absMatch ? absMatch[1].replace(/\s+/g, ' ').trim() : '';
  });
  return map;
}

function parseSummaries(result, idlist) {
  return idlist.map(pmid => {
    const art = result[pmid];
    if (!art) return null;

    const authors = (art.authors || []).map(a => a.name);
    const authorStr = authors.length > 3
      ? `${authors.slice(0, 3).join(', ')}, et al.`
      : authors.join(', ');

    const pubDate = art.pubdate || art.epubdate || '';
    const year    = pubDate.match(/\d{4}/)?.[0] || '';
    const journal = art.fulljournalname || art.source || '';
    const volume  = art.volume ? `${art.volume}` : '';
    const issue   = art.issue  ? `(${art.issue})` : '';
    const pages   = art.pages  ? `:${art.pages}` : '';
    const doi     = (art.articleids || []).find(i => i.idtype === 'doi')?.value || '';

    // APA-style citation
    const citation = [
      authorStr,
      year ? ` (${year}).` : '.',
      ` ${art.title}`,
      journal ? ` ${journal}` : '',
      volume  ? `, ${volume}${issue}${pages}` : '',
      doi     ? `. https://doi.org/${doi}` : '',
      `. PMID: ${pmid}`,
    ].join('');

    return { pmid, title: art.title, authors: authorStr, year, journal, volume, issue, pages, doi, pubDate, citation };
  }).filter(Boolean);
}

// ─── Render results ───────────────────────────────────────────────────────────
function renderResults(papers, totalCount, genes, keywords) {
  document.getElementById('result-count').textContent = `${papers.length} of ${totalCount} papers`;
  document.getElementById('results').style.display = 'block';

  const container = document.getElementById('papers');
  container.innerHTML = '';

  papers.forEach((p, idx) => {
    const hasAbstract = p.abstract && p.abstract.length > 0;
    const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`;

    const card = document.createElement('div');
    card.className = 'paper-card';
    card.innerHTML = `
      <div class="paper-title">
        <a href="${pubmedUrl}" target="_blank" rel="noopener">${escHtml(p.title)}</a>
      </div>
      <div class="paper-meta">
        <span>${escHtml(p.authors)}</span>
        ${p.year ? `<span class="tag">${p.year}</span>` : ''}
        ${p.journal ? `<span class="tag">${escHtml(p.journal)}</span>` : ''}
        ${p.doi ? `<a href="https://doi.org/${p.doi}" target="_blank" rel="noopener" style="color:#58a6ff;font-size:0.78rem">DOI</a>` : ''}
        <a href="${pubmedUrl}" target="_blank" rel="noopener" style="color:#8b949e;font-size:0.78rem">PMID ${p.pmid}</a>
      </div>
      ${hasAbstract ? `
        <div class="paper-abstract collapsed" id="abs-${idx}">${escHtml(p.abstract)}</div>
        <button class="toggle-abstract" onclick="toggleAbstract(${idx})">Show abstract ▾</button>
      ` : `<p style="font-size:0.82rem;color:#484f58;margin-bottom:10px">No abstract available</p>`}
      <div class="citation-box">
        <span class="citation-text" id="cit-${idx}">${escHtml(p.citation)}</span>
        <button class="btn-copy" onclick="copyCitation(${idx})">Copy</button>
      </div>
    `;
    container.appendChild(card);
  });

  // store for export
  window._papers = papers;
}

function toggleAbstract(idx) {
  const el  = document.getElementById(`abs-${idx}`);
  const btn = el.nextElementSibling;
  if (el.classList.contains('collapsed')) {
    el.classList.remove('collapsed');
    btn.textContent = 'Hide abstract ▴';
  } else {
    el.classList.add('collapsed');
    btn.textContent = 'Show abstract ▾';
  }
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
  const text = papers.map((p, i) => `[${i + 1}] ${p.citation}`).join('\n\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'gene_search_citations.txt';
  a.click();
}

// ─── UI utilities ─────────────────────────────────────────────────────────────
function setLoading(on) {
  const btn     = document.getElementById('search-btn');
  const spinner = document.getElementById('spinner');
  const icon    = document.getElementById('search-icon');
  btn.disabled       = on;
  spinner.style.display = on ? 'block' : 'none';
  icon.style.display    = on ? 'none'  : 'block';
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function showError(msg) {
  const box = document.getElementById('error-box');
  box.textContent = msg;
  box.style.display = 'block';
}

function clearError() {
  const box = document.getElementById('error-box');
  box.textContent = '';
  box.style.display = 'none';
}

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Allow Enter key in textareas to trigger search (Ctrl/Cmd+Enter)
['genes', 'keywords'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runSearch();
  });
});
