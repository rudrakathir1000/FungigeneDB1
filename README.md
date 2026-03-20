# MycoTF — Backend API

Fungi Transcription Factor Explorer · REST API

Wraps the **UniProt REST API** with caching, CORS, and structured responses.
Available in two flavours — Python/Flask or Node.js/Express.

---

## Quick Start

### Python / Flask
```bash
pip install -r requirements.txt
python app.py
# → http://localhost:5000
```

### Node.js / Express
```bash
npm install
npm start
# → http://localhost:5000
```

### Production (Python)
```bash
gunicorn -w 4 -b 0.0.0.0:5000 app:app
```

### Production (Node)
```bash
npm run prod
```

---

## Environment Variables

| Variable | Default | Description               |
|----------|---------|---------------------------|
| `PORT`   | `5000`  | Server listen port        |
| `DEBUG`  | `true`  | Flask debug mode (Python) |

---

## API Reference

### `GET /api/health`
Server and upstream connectivity check.
```json
{
  "status": "ok",
  "timestamp": 1710000000,
  "cache_entries": 12,
  "upstream": { "uniprot": true }
}
```

---

### `GET /api/organisms`
List of supported fungal organisms with taxon IDs.
```json
{
  "organisms": [
    { "name": "All Fungi", "taxon_id": 4751, "filter": "taxonomy_id:4751" },
    { "name": "Saccharomyces cerevisiae", "taxon_id": 559292, ... },
    ...
  ]
}
```

---

### `GET /api/search`
Search for fungal transcription factors.

**Query Parameters:**

| Param      | Type    | Required | Description                            |
|------------|---------|----------|----------------------------------------|
| `q`        | string  | ✓        | Gene name, protein name, or accession  |
| `organism` | string  |          | Filter by organism name                |
| `size`     | integer |          | Max results (default 20, max 50)       |
| `reviewed` | boolean |          | Restrict to Swiss-Prot reviewed only   |

**Example:**
```
GET /api/search?q=GAL4&organism=Saccharomyces+cerevisiae&size=10
```

**Response:**
```json
{
  "total": 5,
  "query": "GAL4",
  "organism": "Saccharomyces cerevisiae",
  "hits": [
    {
      "accession": "P04386",
      "entry_id":  "GAL4_YEAST",
      "protein":   "Regulatory protein GAL4",
      "genes":     ["GAL4"],
      "organism":  "Saccharomyces cerevisiae",
      "taxon_id":  559292,
      "length":    881,
      "reviewed":  true,
      "is_tf":     true,
      "keywords":  ["Transcription", "DNA-binding", "Nucleus", ...]
    }
  ]
}
```

---

### `GET /api/protein/:accession`
Full protein record for a UniProt accession.

**Example:** `GET /api/protein/P04386`

**Response includes:**
- Protein identity (name, genes, organism, lineage)
- Function annotation text
- Subcellular localisation
- PTM notes
- Sequence (value, length, molecular weight, CRC64)
- All features (domains, helices, binding sites, etc.)
- Keywords
- GO term count
- All UniProt cross-references

---

### `GET /api/protein/:accession/sequence`
Sequence data + FASTA + amino-acid composition.

```json
{
  "accession":   "P04386",
  "name":        "Regulatory protein GAL4",
  "length":      881,
  "sequence":    "MKLLSSIEQACDICRLKKLKCSKEKP...",
  "fasta":       ">P04386 | Regulatory protein GAL4\nMKLLSSIEQAC...",
  "mol_weight":  99374,
  "crc64":       "A1B2C3D4E5F60001",
  "composition": { "M": 12, "K": 56, "L": 48, ... }
}
```

---

### `GET /api/protein/:accession/domains`
Domain architecture and all structural feature annotations.

```json
{
  "accession":   "P04386",
  "seq_length":  881,
  "features": {
    "domains":   [{ "type": "Domain", "description": "Zinc finger", "start": 8, "end": 40, "length": 33 }],
    "regions":   [...],
    "motifs":    [...],
    "binding":   [...],
    "act_sites": [...],
    "helices":   [...],
    "strands":   [...],
    "turns":     [...],
    "signals":   [...]
  },
  "all_features": [...]
}
```

---

### `GET /api/protein/:accession/go`
GO term annotations grouped by namespace.

```json
{
  "accession": "P04386",
  "total": 24,
  "molecular_function": [
    {
      "id": "GO:0003700",
      "term": "DNA-binding transcription factor activity",
      "namespace": "molecular_function",
      "evidence": "IDA",
      "url": "https://www.ebi.ac.uk/QuickGO/term/GO:0003700"
    }
  ],
  "biological_process": [...],
  "cellular_component": [...]
}
```

---

### `GET /api/protein/:accession/ptm`
Post-translational modifications and processing features.

```json
{
  "accession": "P04386",
  "notes": "Phosphorylated by Cdc28/Cln3 ...",
  "total": 8,
  "modifications": [
    { "type": "Modified residue", "description": "Phosphoserine", "start": 22, "end": 22 },
    { "type": "Disulfide bond",   "description": null, "start": 11, "end": 28 }
  ]
}
```

---

### `GET /api/protein/:accession/xrefs`
Cross-references grouped by category with direct URLs.

```json
{
  "accession": "P04386",
  "categories": {
    "structure":     [{ "database": "PDB", "id": "3COQ", "url": "https://www.rcsb.org/structure/3COQ" }],
    "interaction":   [{ "database": "STRING", "id": "4932.YPL248C" }],
    "pathway":       [{ "database": "KEGG", "id": "sce:YPL248C" }],
    "gene":          [...],
    "family_domain": [{ "database": "Pfam", "id": "PF00107" }],
    "ontology":      [...]
  },
  "other": [...]
}
```

---

### `POST /api/cache/clear`
Clear the in-memory cache. Returns count of cleared entries.

### `GET /api/cache/stats`
Show current cache entry count and key sample.

---

## Architecture

```
mycotf_backend/
├── app.py            ← Python/Flask backend
├── server.js         ← Node.js/Express backend  
├── requirements.txt  ← Python dependencies
├── package.json      ← Node.js dependencies
└── README.md

Data Flow:
  Browser / Frontend
       │
       ▼
  MycoTF Backend  (port 5000)
       │  In-memory cache (1h TTL)
       ▼
  UniProt REST API  (rest.uniprot.org)
       │
       ▼
  Structured JSON → Frontend tabs
```

## Caching Strategy
All responses are cached in-memory with a 1-hour TTL.
Cache key = MD5 of (route + query params).
On a cache hit the response includes `"cached": true`.

## Error Codes
| Code | Meaning                       |
|------|-------------------------------|
| 400  | Missing or invalid parameters |
| 404  | Route not found               |
| 502  | UniProt unreachable           |
| 504  | UniProt timed out             |
| 500  | Unexpected server error       |
