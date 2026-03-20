/**
 * MycoTF — Fungi Transcription Factor Explorer
 * Backend API Server (Node.js / Express)
 *
 * Alternative to the Python/Flask backend.
 * Mirrors all routes and behaviour.
 *
 * Install:
 *   npm install express cors node-fetch node-cache
 *
 * Run:
 *   node server.js
 *   PORT=5000 node server.js
 */

"use strict";

const express  = require("express");
const cors     = require("cors");
const NodeCache = require("node-cache");
const fetch    = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

// ─────────────────────────────────────────
//  Config
// ─────────────────────────────────────────
const PORT           = process.env.PORT || 5000;
const UNIPROT_BASE   = "https://rest.uniprot.org/uniprotkb";
const CACHE_TTL_SEC  = 3600;   // 1 hour
const REQ_TIMEOUT_MS = 20_000;

const UNIPROT_FULL_FIELDS = [
  "accession","reviewed","id","protein_name","gene_names",
  "organism_name","length","sequence",
  "go","cc_function","cc_subcellular_location","cc_ptm",
  "ft_domain","ft_region","ft_motif","ft_binding",
  "ft_act_site","ft_mod_res","ft_signal","ft_peptide",
  "ft_helix","ft_strand","ft_turn",
  "keyword",
  "xref_pdb","xref_alphafolddb","xref_string","xref_intact",
  "xref_geneontology","xref_pfam","xref_interpro",
  "xref_ncbigene","xref_kegg","xref_biogrid","xref_reactome",
  "cc_similarity","entry_audit",
].join(",");

const UNIPROT_SEARCH_FIELDS = [
  "accession","reviewed","id","protein_name",
  "gene_names","organism_name","length","keyword",
].join(",");

const SUPPORTED_FUNGI = [
  { name: "All Fungi",                  taxon_id: 4751,   filter: "taxonomy_id:4751" },
  { name: "Saccharomyces cerevisiae",   taxon_id: 559292, filter: 'organism_name:"Saccharomyces cerevisiae"' },
  { name: "Aspergillus nidulans",       taxon_id: 227321, filter: 'organism_name:"Aspergillus nidulans"' },
  { name: "Neurospora crassa",          taxon_id: 367110, filter: 'organism_name:"Neurospora crassa"' },
  { name: "Candida albicans",           taxon_id: 237561, filter: 'organism_name:"Candida albicans"' },
  { name: "Schizosaccharomyces pombe",  taxon_id: 284812, filter: 'organism_name:"Schizosaccharomyces pombe"' },
  { name: "Aspergillus fumigatus",      taxon_id: 746128, filter: 'organism_name:"Aspergillus fumigatus"' },
  { name: "Cryptococcus neoformans",    taxon_id: 235443, filter: 'organism_name:"Cryptococcus neoformans"' },
];

// ─────────────────────────────────────────
//  App & Middleware
// ─────────────────────────────────────────
const app   = express();
const cache = new NodeCache({ stdTTL: CACHE_TTL_SEC, checkperiod: 120 });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Request logger
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────
//  UniProt Fetch Utility
// ─────────────────────────────────────────
async function uniprotGet(path, params = {}) {
  const url = new URL(`${UNIPROT_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);

  try {
    const resp = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal:  controller.signal,
    });
    if (!resp.ok) throw { status: resp.status, message: `UniProt ${resp.status}` };
    return await resp.json();
  } catch (err) {
    if (err.name === "AbortError") throw { status: 504, message: "UniProt timed out" };
    throw err.status ? err : { status: 502, message: "Failed to reach UniProt" };
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────
//  Query Builder
// ─────────────────────────────────────────
function buildQuery(q, organism) {
  const orgFilter = organism
    ? (SUPPORTED_FUNGI.find(f => f.name === organism)?.filter
       ?? `organism_name:"${organism}"`)
    : "taxonomy_id:4751";

  const escaped = q.replace(/"/g, '\\"');
  return `(${orgFilter}) AND (protein_name:"${escaped}" OR gene:"${escaped}" OR accession:${escaped})`;
}

// ─────────────────────────────────────────
//  Shape Helpers
// ─────────────────────────────────────────
function shapeHit(entry) {
  const pd   = entry.proteinDescription ?? {};
  const rec  = pd.recommendedName ?? {};
  const sub  = pd.submittedName?.[0] ?? {};
  const pname = rec.fullName?.value ?? sub.fullName?.value ?? "Unknown protein";

  const genes = (entry.genes ?? [])
    .map(g => g.geneName?.value).filter(Boolean);

  const kws   = (entry.keywords ?? []).map(k => k.name.toLowerCase());
  const is_tf = kws.some(k => k.includes("transcription")) ||
                pname.toLowerCase().includes("transcription");

  return {
    accession: entry.primaryAccession,
    entry_id:  entry.uniProtkbId,
    protein:   pname,
    genes,
    organism:  entry.organism?.scientificName,
    taxon_id:  entry.organism?.taxonId,
    length:    entry.sequence?.length,
    reviewed:  entry.entryType === "UniProtKB reviewed (Swiss-Prot)",
    is_tf,
    keywords:  (entry.keywords ?? []).slice(0, 8).map(k => k.name),
  };
}

function shapeFeature(feat) {
  const loc = feat.location ?? {};
  const s   = loc.start?.value;
  const e   = loc.end?.value;
  return {
    type:        feat.type,
    description: feat.description ?? "",
    start:       s,
    end:         e,
    length:      (s != null && e != null) ? e - s + 1 : null,
    evidences:   (feat.evidences ?? []).map(ev => ev.evidenceCode),
  };
}

function shapeFullProtein(entry) {
  const hit = shapeHit(entry);
  const comments = entry.comments ?? [];

  const getText = type => comments
    .filter(c => c.commentType === type)
    .flatMap(c => c.texts ?? [])
    .map(t => t.value)
    .join(" ");

  const locations = comments
    .filter(c => c.commentType === "SUBCELLULAR LOCATION")
    .flatMap(c => c.subcellularLocations ?? [])
    .map(s => s.location?.value)
    .filter(Boolean);

  const seq   = entry.sequence ?? {};
  const audit = entry.entryAudit ?? {};

  return {
    ...hit,
    function:         getText("FUNCTION"),
    subcellular_loc:  locations,
    ptm_note:         getText("PTM"),
    similarity:       getText("SIMILARITY"),
    lineage:          entry.organism?.lineage ?? [],
    created:          audit.firstPublicDate,
    last_modified:    audit.lastAnnotationUpdateDate,
    sequence: {
      value:      seq.value ?? "",
      length:     seq.length,
      mol_weight: seq.molWeight,
      crc64:      seq.crc64,
    },
    features: (entry.features ?? []).map(shapeFeature),
    keywords: (entry.keywords ?? []).map(k => ({ id: k.id, name: k.name })),
    xrefs:    entry.uniProtKBCrossReferences ?? [],
    go_count: (entry.uniProtKBCrossReferences ?? [])
                .filter(r => r.database === "GO").length,
  };
}

// ─────────────────────────────────────────
//  Error Wrapper
// ─────────────────────────────────────────
function wrap(fn) {
  return async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (err) {
      const code = err.status ?? 500;
      console.error(`Error ${code}:`, err.message ?? err);
      res.status(code).json({ error: true, message: err.message ?? "Internal error", code });
    }
  };
}

// ─────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────

// Health check
app.get("/api/health", wrap(async (_req, res) => {
  let uniprotOk = false;
  try {
    const r = await uniprotGet("/search", {
      query: "GAL4 taxonomy_id:4751", format: "json", size: 1 });
    uniprotOk = Array.isArray(r.results);
  } catch (_) {}

  res.json({
    status:       "ok",
    timestamp:    Date.now(),
    cache_keys:   cache.keys().length,
    upstream:     { uniprot: uniprotOk },
  });
}));

// Supported organisms
app.get("/api/organisms", (_req, res) => {
  res.json({ organisms: SUPPORTED_FUNGI });
});

// Search
app.get("/api/search", wrap(async (req, res) => {
  const q        = (req.query.q ?? "").trim();
  const organism = (req.query.organism ?? "").trim();
  const size     = Math.min(parseInt(req.query.size ?? 20), 50);
  const reviewed = req.query.reviewed === "true";

  if (!q) return res.status(400).json({ error: true, message: "Query 'q' required" });

  let query = buildQuery(q, organism);
  if (reviewed) query += " AND (reviewed:true)";

  const ck = `search:${query}:${size}`;
  const cached = cache.get(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const data = await uniprotGet("/search", {
    query, format: "json", size, fields: UNIPROT_SEARCH_FIELDS,
  });

  const hits = (data.results ?? []).map(shapeHit);
  const payload = { total: hits.length, query: q,
                    organism: organism || "All Fungi", hits };

  cache.set(ck, payload);
  res.json(payload);
}));

// Full protein
app.get("/api/protein/:accession", wrap(async (req, res) => {
  const acc = req.params.accession.toUpperCase();
  const ck  = `protein:${acc}`;
  const cached = cache.get(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const data    = await uniprotGet(`/${acc}`, { format: "json", fields: UNIPROT_FULL_FIELDS });
  const payload = shapeFullProtein(data);

  cache.set(ck, payload);
  res.json(payload);
}));

// Sequence
app.get("/api/protein/:accession/sequence", wrap(async (req, res) => {
  const acc = req.params.accession.toUpperCase();
  const ck  = `seq:${acc}`;
  const cached = cache.get(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const data = await uniprotGet(`/${acc}`, {
    format: "json", fields: "accession,sequence,protein_name" });

  const seq  = data.sequence?.value ?? "";
  const name = data.proteinDescription?.recommendedName?.fullName?.value ?? acc;

  const composition = {};
  for (const aa of seq) composition[aa] = (composition[aa] ?? 0) + 1;

  const fasta = `>${acc} | ${name}\n` +
    seq.match(/.{1,60}/g).join("\n");

  const payload = {
    accession: acc, name, length: seq.length, sequence: seq, fasta,
    mol_weight: data.sequence?.molWeight,
    crc64:      data.sequence?.crc64,
    composition,
  };

  cache.set(ck, payload);
  res.json(payload);
}));

// Domains & features
app.get("/api/protein/:accession/domains", wrap(async (req, res) => {
  const acc = req.params.accession.toUpperCase();
  const ck  = `domains:${acc}`;
  const cached = cache.get(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const data = await uniprotGet(`/${acc}`, {
    format: "json",
    fields: "accession,sequence,ft_domain,ft_region,ft_motif,ft_binding,"
          + "ft_act_site,ft_helix,ft_strand,ft_turn,ft_signal,ft_peptide",
  });

  const features = data.features ?? [];
  const seqLen   = data.sequence?.length ?? 1;

  const TYPE_MAP = {
    domains:   ["Domain"],
    regions:   ["Region"],
    motifs:    ["Motif"],
    binding:   ["Binding site"],
    act_sites: ["Active site"],
    helices:   ["Helix"],
    strands:   ["Beta strand"],
    turns:     ["Turn"],
    signals:   ["Signal peptide", "Transit peptide", "Propeptide"],
  };

  const grouped = Object.fromEntries(Object.keys(TYPE_MAP).map(k => [k, []]));
  for (const feat of features) {
    for (const [group, types] of Object.entries(TYPE_MAP)) {
      if (types.includes(feat.type)) { grouped[group].push(shapeFeature(feat)); break; }
    }
  }

  const payload = {
    accession: acc, seq_length: seqLen,
    features:  grouped,
    all_features: features.map(shapeFeature),
  };

  cache.set(ck, payload);
  res.json(payload);
}));

// GO terms
app.get("/api/protein/:accession/go", wrap(async (req, res) => {
  const acc = req.params.accession.toUpperCase();
  const ck  = `go:${acc}`;
  const cached = cache.get(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const data = await uniprotGet(`/${acc}`, {
    format: "json", fields: "accession,go,xref_geneontology" });

  const refs = (data.uniProtKBCrossReferences ?? []).filter(r => r.database === "GO");

  const NS_MAP = { P: "biological_process", F: "molecular_function", C: "cellular_component" };

  const goTerms = refs.map(r => {
    const props   = Object.fromEntries((r.properties ?? []).map(p => [p.key, p.value]));
    const goTerm  = props.GoTerm ?? "";
    const nsChar  = goTerm[0] ?? "";
    return {
      id:        r.id,
      term:      goTerm.slice(2),
      namespace: NS_MAP[nsChar] ?? "unknown",
      evidence:  props.GoEvidenceType ?? "",
      url:       `https://www.ebi.ac.uk/QuickGO/term/${r.id}`,
    };
  });

  const payload = {
    accession: acc, total: goTerms.length,
    molecular_function: goTerms.filter(t => t.namespace === "molecular_function"),
    biological_process: goTerms.filter(t => t.namespace === "biological_process"),
    cellular_component: goTerms.filter(t => t.namespace === "cellular_component"),
  };

  cache.set(ck, payload);
  res.json(payload);
}));

// PTM
app.get("/api/protein/:accession/ptm", wrap(async (req, res) => {
  const acc = req.params.accession.toUpperCase();
  const ck  = `ptm:${acc}`;
  const cached = cache.get(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const data = await uniprotGet(`/${acc}`, {
    format: "json", fields: "accession,ft_mod_res,ft_signal,ft_peptide,cc_ptm" });

  const PTM_TYPES = [
    "Modified residue","Glycosylation","Lipidation","Disulfide bond",
    "Cross-link","Propeptide","Signal peptide","Transit peptide","Chain","Peptide",
  ];

  const mods = (data.features ?? []).filter(f => PTM_TYPES.includes(f.type));
  const notes = (data.comments ?? [])
    .filter(c => c.commentType === "PTM")
    .flatMap(c => c.texts ?? [])
    .map(t => t.value)
    .join(" ");

  const payload = {
    accession: acc, notes, total: mods.length,
    modifications: mods.map(shapeFeature),
  };

  cache.set(ck, payload);
  res.json(payload);
}));

// Cross-references
app.get("/api/protein/:accession/xrefs", wrap(async (req, res) => {
  const acc = req.params.accession.toUpperCase();
  const ck  = `xrefs:${acc}`;
  const cached = cache.get(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const data = await uniprotGet(`/${acc}`, {
    format: "json",
    fields: "accession,xref_pdb,xref_alphafolddb,xref_string,xref_intact,"
          + "xref_geneontology,xref_pfam,xref_interpro,xref_ncbigene,"
          + "xref_kegg,xref_biogrid,xref_reactome",
  });

  const DB_CATS = {
    structure:     ["PDB","AlphaFoldDB"],
    interaction:   ["STRING","IntAct","BioGRID"],
    pathway:       ["KEGG","Reactome"],
    gene:          ["NCBI Gene","EnsemblFungi","RefSeq"],
    family_domain: ["Pfam","InterPro","SUPFAM","Gene3D","PANTHER"],
    ontology:      ["GO"],
  };

  const DB_URLS = {
    PDB:          i => `https://www.rcsb.org/structure/${i}`,
    AlphaFoldDB:  i => `https://alphafold.ebi.ac.uk/entry/${i}`,
    STRING:       i => `https://string-db.org/network/${i}`,
    IntAct:       i => `https://www.ebi.ac.uk/intact/query/${i}`,
    KEGG:         i => `https://www.genome.jp/entry/${i}`,
    Reactome:     i => `https://reactome.org/PathwayBrowser/#${i}`,
    "NCBI Gene":  i => `https://www.ncbi.nlm.nih.gov/gene/${i}`,
    EnsemblFungi: i => `https://fungi.ensembl.org/id/${i}`,
    Pfam:         i => `https://www.ebi.ac.uk/interpro/entry/pfam/${i}`,
    InterPro:     i => `https://www.ebi.ac.uk/interpro/entry/InterPro/${i}`,
    GO:           i => `https://www.ebi.ac.uk/QuickGO/term/${i}`,
  };

  const grouped = Object.fromEntries(Object.keys(DB_CATS).map(k => [k, []]));
  const other   = [];
  const catDbs  = new Set(Object.values(DB_CATS).flat());

  for (const ref of data.uniProtKBCrossReferences ?? []) {
    const db  = ref.database;
    const item = {
      database: db, id: ref.id,
      url: DB_URLS[db]?.(ref.id) ?? null,
      properties: Object.fromEntries((ref.properties ?? []).map(p => [p.key, p.value])),
    };

    let placed = false;
    for (const [cat, dbs] of Object.entries(DB_CATS)) {
      if (dbs.includes(db)) { grouped[cat].push(item); placed = true; break; }
    }
    if (!placed) other.push(item);
  }

  const payload = { accession: acc, categories: grouped, other };
  cache.set(ck, payload);
  res.json(payload);
}));

// Cache admin
app.post("/api/cache/clear", (_req, res) => {
  const count = cache.keys().length;
  cache.flushAll();
  res.json({ cleared: count });
});

app.get("/api/cache/stats", (_req, res) => {
  res.json({ entries: cache.keys().length, keys: cache.keys().slice(0, 20) });
});

// Google OAuth Client
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
let googleClient;
try {
  const { OAuth2Client } = require('google-auth-library');
  googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
} catch (e) {
  console.warn("Notice: google-auth-library not installed. Google Sign-In verification will use a mock bypass.");
}

// Auth & Upload
const fs = require('fs');
const USERS_FILE = './users.json';

let users = []; 
try {
  if (fs.existsSync(USERS_FILE)) {
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    users = JSON.parse(data);
  }
} catch (err) {
  console.log("Error loading users.json:", err);
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

app.post("/api/signup", (req, res) => {
  const { email, username, password } = req.body;
  if (!username || !password || !email) {
    return res.status(400).json({ error: true, message: "Missing fields" });
  }
  if (users.find(u => u.username === username)) {
    return res.status(409).json({ error: true, message: "Username is already taken" });
  }
  users.push({ email, username, password });
  saveUsers();
  res.json({ message: "Sign up successful! You can now log in.", success: true });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    res.json({ token: "mock-jwt-token-" + Date.now(), message: "Login successful", username });
  } else {
    if (users.length === 0 && username === "admin" && password === "admin") {
       res.json({ token: "mock-jwt-admin", message: "Fallback admin login", username });
    } else {
       res.status(401).json({ error: true, message: "Invalid credentials" });
    }
  }
});

app.post("/api/auth/google", async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: true, message: "Missing Google token payload" });

  try {
    let payload;
    if (googleClient) {
      const ticket = await googleClient.verifyIdToken({
          idToken: credential,
          audience: GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } else {
      console.warn("Mocking Google validation -> API library missing");
      payload = { email: "mockuser@google.com", name: "Google User", sub: "mock-google-id123" };
    }

    const { email, name, sub } = payload;
    let user = users.find(u => u.googleId === sub || u.email === email);
    if (!user) {
      user = { email, username: name.replace(/\s+/g,'').toLowerCase() + Math.random().toString().slice(2,5), googleId: sub };
      users.push(user);
      saveUsers();
    }

    res.json({ token: "mock-jwt-google-" + Date.now(), message: "Google Sign-In successful!", username: user.username });
  } catch (error) {
    console.error("Google auth verify error:", error);
    res.status(401).json({ error: true, message: "Google Token invalid or expired." });
  }
});

app.post("/api/upload", (req, res) => {
  console.log("Received upload data:", req.body);
  res.json({ success: true, message: "Fungi data uploaded successfully!" });
});

// Admin Features
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "Admin123" && password === "Rudra123") {
    res.json({ token: "admin-jwt-token-" + Date.now(), message: "Admin Login successful" });
  } else {
    res.status(401).json({ error: true, message: "Invalid admin credentials" });
  }
});

let serverGenes = [
  { id:'FGD0001', name:'AreA', species:'Aspergillus niger', phylum:'Ascomycota', class:'Eurotiomycetes', order:'Eurotiales', family:'Aspergillaceae', genus:'Aspergillus', type:'TF', tfFamily:'GATA', function:'Nitrogen catabolite repression', chr:'Chr1', strand:'+', start:1024500, end:1027300, length:2800, introns:3, mrnaLen:1840, cdsLen:1620, protein:540, gc:52.3, seqKey:'areA', accession:'XM_001393476', refs:{ncbi:'XM_001393476',uniprot:'Q5B7I7',fungidb:'Afu1g00090'} },
  { id:'FGD0002', name:'NIT2', species:'Neurospora crassa', phylum:'Ascomycota', class:'Sordariomycetes', order:'Sordariales', family:'Sordariaceae', genus:'Neurospora', type:'TF', tfFamily:'GATA', function:'Nitrogen metabolism', chr:'LG1', strand:'+', start:4521000, end:4524200, length:3200, introns:4, mrnaLen:1920, cdsLen:1680, protein:560, gc:53.1, seqKey:'areA', accession:'XM_956726', refs:{ncbi:'XM_956726',uniprot:'Q9Y7L3',fungidb:'NCU01224'} },
  { id:'FGD0003', name:'Crz1', species:'Saccharomyces cerevisiae', phylum:'Ascomycota', class:'Saccharomycetes', order:'Saccharomycetales', family:'Saccharomycetaceae', genus:'Saccharomyces', type:'TF', tfFamily:'C2H2', function:'Calcineurin-dependent stress response', chr:'ChrIV', strand:'-', start:815200, end:818100, length:2900, introns:0, mrnaLen:2150, cdsLen:1920, protein:640, gc:38.7, seqKey:'crz1', accession:'NM_001181793', refs:{ncbi:'NM_001181793',uniprot:'P53968',fungidb:'YNL027W'} },
  { id:'FGD0004', name:'VeA', species:'Aspergillus fumigatus', phylum:'Ascomycota', class:'Eurotiomycetes', order:'Eurotiales', family:'Aspergillaceae', genus:'Aspergillus', type:'TF', tfFamily:'Velvet', function:'Light-regulated secondary metabolism', chr:'Chr1', strand:'+', start:2301400, end:2304600, length:3200, introns:2, mrnaLen:2080, cdsLen:1860, protein:620, gc:50.8, seqKey:'areA', accession:'XM_747978', refs:{ncbi:'XM_747978',uniprot:'Q4WAA9',fungidb:'Afu1g12700'} },
  { id:'FGD0005', name:'Hap2', species:'Candida albicans', phylum:'Ascomycota', class:'Saccharomycetes', order:'Saccharomycetales', family:'Saccharomycetaceae', genus:'Candida', type:'TF', tfFamily:'Homeobox', function:'Mating type switching', chr:'Chr2', strand:'+', start:1400200, end:1402800, length:2600, introns:1, mrnaLen:1780, cdsLen:1560, protein:520, gc:36.4, seqKey:'crz1', accession:'XM_716279', refs:{ncbi:'XM_716279',uniprot:'Q59RQ4',fungidb:'orf19.3903'} },
  { id:'FGD0006', name:'Rim101', species:'Cryptococcus neoformans', phylum:'Basidiomycota', class:'Tremellomycetes', order:'Tremellales', family:'Cryptococcaceae', genus:'Cryptococcus', type:'TF', tfFamily:'Zn2Cys6', function:'pH-responsive gene expression', chr:'ChrIV', strand:'-', start:672100, end:674500, length:2400, introns:5, mrnaLen:1640, cdsLen:1440, protein:480, gc:60.2, seqKey:'areA', accession:'XM_012196548', refs:{ncbi:'XM_012196548',uniprot:'Q5KI07',fungidb:'CNAG_01586'} },
  { id:'FGD0007', name:'Brlz1', species:'Ustilago maydis', phylum:'Basidiomycota', class:'Ustilaginomycetes', order:'Ustilaginales', family:'Ustilaginaceae', genus:'Ustilago', type:'TF', tfFamily:'bZIP', function:'Fungal pathogenicity regulation', chr:'Chr21', strand:'+', start:384000, end:386200, length:2200, introns:3, mrnaLen:1540, cdsLen:1320, protein:440, gc:58.9, seqKey:'crz1', accession:'XM_011391258', refs:{ncbi:'XM_011391258',uniprot:'A0A0D1DS14',fungidb:'UMAG_01829'} },
  { id:'FGD0008', name:'Ace1', species:'Trichoderma reesei', phylum:'Ascomycota', class:'Sordariomycetes', order:'Hypocreales', family:'Hypocreaceae', genus:'Trichoderma', type:'TF', tfFamily:'C2H2', function:'Cellulase gene repression', chr:'ScfChr1', strand:'-', start:942300, end:944100, length:1800, introns:2, mrnaLen:1340, cdsLen:1200, protein:400, gc:54.7, seqKey:'crz1', accession:'XM_006962382', refs:{ncbi:'XM_006962382',uniprot:'Q7Z997',fungidb:'Trire2_2904'} },
  { id:'FGD0009', name:'Hac1', species:'Neurospora crassa', phylum:'Ascomycota', class:'Sordariomycetes', order:'Sordariales', family:'Sordariaceae', genus:'Neurospora', type:'TF', tfFamily:'bZIP', function:'Unfolded protein response', chr:'LG3', strand:'+', start:5820100, end:5822900, length:2800, introns:2, mrnaLen:1900, cdsLen:1680, protein:560, gc:51.8, seqKey:'areA', accession:'XM_963448', refs:{ncbi:'XM_963448',uniprot:'Q7SA23',fungidb:'NCU03169'} },
  { id:'FGD0010', name:'MsnA', species:'Aspergillus nidulans', phylum:'Ascomycota', class:'Eurotiomycetes', order:'Eurotiales', family:'Aspergillaceae', genus:'Aspergillus', type:'TF', tfFamily:'C2H2', function:'General stress response', chr:'Chr3', strand:'+', start:3105000, end:3107300, length:2300, introns:3, mrnaLen:1680, cdsLen:1500, protein:500, gc:51.2, seqKey:'crz1', accession:'XM_659081', refs:{ncbi:'XM_659081',uniprot:'Q5B3L6',fungidb:'AN5720'} },
  { id:'FGD0011', name:'Wor1', species:'Candida albicans', phylum:'Ascomycota', class:'Saccharomycetes', order:'Saccharomycetales', family:'Saccharomycetaceae', genus:'Candida', type:'TF', tfFamily:'WD40', function:'White-opaque phenotypic switching', chr:'Chr5', strand:'+', start:2118300, end:2120800, length:2500, introns:0, mrnaLen:2120, cdsLen:1920, protein:640, gc:37.1, seqKey:'areA', accession:'XM_720699', refs:{ncbi:'XM_720699',uniprot:'Q5ARZ6',fungidb:'orf19.5992'} },
  { id:'FGD0012', name:'StuA', species:'Aspergillus fumigatus', phylum:'Ascomycota', class:'Eurotiomycetes', order:'Eurotiales', family:'Aspergillaceae', genus:'Aspergillus', type:'TF', tfFamily:'Homeobox', function:'Conidiophore development', chr:'Chr2', strand:'-', start:1688000, end:1691000, length:3000, introns:4, mrnaLen:2100, cdsLen:1860, protein:620, gc:49.6, seqKey:'crz1', accession:'XM_749208', refs:{ncbi:'XM_749208',uniprot:'Q4X0G3',fungidb:'Afu2g11120'} },
  { id:'FGD0013', name:'PacC', species:'Aspergillus niger', phylum:'Ascomycota', class:'Eurotiomycetes', order:'Eurotiales', family:'Aspergillaceae', genus:'Aspergillus', type:'TF', tfFamily:'C2H2', function:'Ambient pH response', chr:'Chr6', strand:'+', start:876000, end:878500, length:2500, introns:3, mrnaLen:1740, cdsLen:1560, protein:520, gc:52.6, seqKey:'areA', accession:'XM_001396312', refs:{ncbi:'XM_001396312',uniprot:'Q5B2W9',fungidb:'An14g06220'} },
  { id:'FGD0014', name:'Ste12', species:'Saccharomyces cerevisiae', phylum:'Ascomycota', class:'Saccharomycetes', order:'Saccharomycetales', family:'Saccharomycetaceae', genus:'Saccharomyces', type:'TF', tfFamily:'Homeobox', function:'Mating pheromone pathway', chr:'ChrXI', strand:'+', start:641100, end:643900, length:2800, introns:0, mrnaLen:2400, cdsLen:2160, protein:720, gc:39.8, seqKey:'crz1', accession:'NM_001182063', refs:{ncbi:'NM_001182063',uniprot:'P13574',fungidb:'YHR084W'} },
  { id:'FGD0015', name:'MetR', species:'Botrytis cinerea', phylum:'Ascomycota', class:'Leotiomycetes', order:'Erysiphales', family:'Sclerotiniaceae', genus:'Botrytis', type:'TF', tfFamily:'Zn2Cys6', function:'Sulfur amino acid metabolism', chr:'ChrIX', strand:'-', start:1341200, end:1343400, length:2200, introns:4, mrnaLen:1560, cdsLen:1380, protein:460, gc:47.3, seqKey:'areA', accession:'XM_001556832', refs:{ncbi:'XM_001556832',uniprot:'A7EFT6',fungidb:'BC1G_16199'} },
];

app.get("/api/genes", (req, res) => {
  res.json({ genes: serverGenes });
});

app.post("/api/admin/gene", (req, res) => {
  const newGene = req.body;
  if (!newGene.id) {
    newGene.id = 'FGD' + Math.floor(Math.random()*10000).toString().padStart(4, '0');
  }
  serverGenes.unshift(newGene);
  res.json({ success: true, message: "Gene added successfully!", gene: newGene });
});

app.delete("/api/admin/gene/:id", (req, res) => {
  const { id } = req.params;
  const initialLen = serverGenes.length;
  serverGenes = serverGenes.filter(g => g.id !== id);
  if (serverGenes.length < initialLen) {
    res.json({ success: true, message: "Gene deleted successfully!" });
  } else {
    res.status(404).json({ error: true, message: "Gene not found" });
  }
});

// 404 fallback
app.use((_req, res) => res.status(404).json({ error: true, message: "Route not found", code: 404 }));

// ─────────────────────────────────────────
//  Start Server
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`MycoTF Node.js backend running → http://localhost:${PORT}/api/health`);
});

module.exports = app;
