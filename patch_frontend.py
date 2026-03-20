import re

file_path = "FungiGeneDB.html"
with open(file_path, "r", encoding="utf-8") as f:
    html = f.read()

# Replace filterTable() completely
patch_filterTable = """
async function filterTable() {
  const q = document.getElementById('browse-filter').value.trim() || 'fungi';
  try {
    const res = await fetch(`http://localhost:5000/api/search?q=${encodeURIComponent(q)}&size=50`);
    const data = await res.json();
    filteredGenes = data.hits || [];
    currentPageNum = 1;
    renderTable();
  } catch (err) {
    console.error(err);
    filteredGenes = [];
    renderTable();
  }
}
"""
html = re.sub(r'function filterTable\(\) \{[\s\S]*?renderTable\(\);\n\}', patch_filterTable.strip() + '\n', html)

# Replace renderTable() completely
patch_renderTable = """
function renderTable() {
  const tbody = document.getElementById('table-body');
  const start = (currentPageNum - 1) * PAGE_SIZE;
  const slice = filteredGenes.slice(start, start + PAGE_SIZE);

  tbody.innerHTML = slice.map(g => `
    <tr onclick="viewGene('${g.accession}')">
      <td><span class="gene-id">${g.accession}</span></td>
      <td><strong style="font-size:14px;">${g.protein}</strong></td>
      <td class="species-name" style="font-size:13px;">${g.organism}</td>
      <td><span class="pill pill-teal">${g.keywords[0]?.name || 'Unknown'}</span></td>
      <td style="font-size:12px;color:var(--text2);">-</td>
      <td><span class="pill pill-sky">${g.is_tf ? 'TF' : 'Protein'}</span></td>
      <td style="font-family:var(--mono);font-size:12px;">${g.length ? g.length.toLocaleString() : '-'}</td>
      <td><button class="seq-copy" onclick="event.stopPropagation();viewGene('${g.accession}')">View →</button></td>
    </tr>`).join('');

  document.getElementById('page-info').textContent =
    `Showing ${start+1}–${Math.min(start+PAGE_SIZE, filteredGenes.length)} of ${filteredGenes.length}`;

  renderPagination();
}
"""
html = re.sub(r'function renderTable\(\) \{[\s\S]*?renderPagination\(\);\n\}', patch_renderTable.strip() + '\n', html)

# Replace viewGene(id) completely
patch_viewGene = """
async function viewGene(id) {
  showPage('detail');
  document.getElementById('d-gene-name').textContent = 'Loading...';
  try {
    const res = await fetch(`http://localhost:5000/api/protein/${id}`);
    const g = await res.json();
    currentGene = g;

    document.getElementById('d-gene-id').textContent = g.entry_id + ' · ' + g.accession;
    document.getElementById('d-gene-name').textContent = g.protein;
    document.getElementById('d-species').textContent = g.organism || '-';
    document.getElementById('d-pills').innerHTML = g.keywords.slice(0, 3).map(k => `<span class="pill pill-sky">${k.name}</span>`).join('');

    document.getElementById('d-meta').innerHTML = [
      { k:'Length', v: (g.length || '-') + ' aa' },
      { k:'Mass', v: (g.sequence?.mol_weight || '-') + ' Da' },
      { k:'Created', v: g.created || '-' },
      { k:'Last Modified', v: g.last_modified || '-' },
      { k:'Function', v: g.function || 'Unknown' }
    ].map(m=>`<div class="meta-item ${m.k==='Function'?'style="grid-column:1/-1"':''}"><div class="meta-key">${m.k}</div><div class="meta-val">${m.v}</div></div>`).join('');

    document.getElementById('d-taxonomy').innerHTML = (g.lineage || []).join(' → ');

    document.getElementById('block-mrna').style.display = 'none';
    document.getElementById('block-cds').style.display = 'none';

    const seqRes = await fetch(`http://localhost:5000/api/protein/${id}/sequence`);
    const seqData = await seqRes.json();
    document.getElementById('prot-len').textContent = seqData.length + ' aa';
    document.getElementById('prot-body').innerHTML = `<span style="color:var(--amber);letter-spacing:0.06em;">${seqData.sequence}</span><span id="prot-seq" style="display:none">${seqData.sequence}</span>`;

    const domRes = await fetch(`http://localhost:5000/api/protein/${id}/domains`);
    const domData = await domRes.json();
    let allDomains = [];
    if (domData.features && domData.features.domains) {
        allDomains = domData.features.domains.map(d => ({ name: d.description || d.type, start: d.start, end: d.end, color: '#4ab8e8' }));
    }
    renderDomainsAPI(allDomains, seqData.length);

    document.getElementById('d-refs').innerHTML = (g.xrefs || []).slice(0,10).map(x =>
      `<a href="${x.url || '#'}" target="_blank" style="text-decoration:none;">
         <span class="pill pill-teal" style="cursor:pointer;">${x.database}: ${x.id}</span>
       </a>`).join('');

  } catch (err) {
    console.error(err);
    document.getElementById('d-gene-name').textContent = 'Error loading gene';
  }
}

function renderDomainsAPI(domains, totalLen) {
  const svg = document.getElementById('domain-svg');
  if(!totalLen) totalLen = 500;
  const W = 900;
  const backbone = `<rect x="20" y="30" width="${W-40}" height="10" rx="5" fill="#1a2e22" stroke="#3dda8a22" stroke-width="1"/>
    <text x="22" y="62" fill="#567868" font-size="10" font-family="monospace">1</text>
    <text x="${W-60}" y="62" fill="#567868" font-size="10" font-family="monospace">${totalLen}aa</text>`;
  const rects = domains.map(d => {
    let x = 20 + (d.start / totalLen) * (W - 40);
    let w = ((d.end - d.start) / totalLen) * (W - 40);
    if(w < 2) w = 2; // min width
    return `<rect x="${x.toFixed(1)}" y="24" width="${w.toFixed(1)}" height="22" rx="4" fill="${d.color}" opacity="0.85"/>
      <text x="${(x + w/2).toFixed(1)}" y="37" text-anchor="middle" fill="#070d0b" font-size="9.5" font-family="monospace" font-weight="700">${d.name.substring(0, 10)}</text>`;
  }).join('');
  svg.innerHTML = backbone + rects;
}
"""

html = re.sub(r'function viewGene\(id\) \{[\s\S]*?showPage\(\'detail\'\);\n\}', patch_viewGene.strip() + '\n', html)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(html)
print("Patch applied.")
