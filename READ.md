# RCSB PDB Metabolite Server

A Node.js REST API server that connects to the **RCSB Protein Data Bank (PDB)** to fetch metabolite data, protein structures, 3D coordinates, and supports filtering by organism, gene, and keyword.

---

## What is RCSB PDB?

RCSB PDB is a free, public database of 3D structures of biological molecules — proteins, DNA, RNA, and the small molecules (ligands/metabolites) that bind to them. Scientists upload solved structures here after research. This server makes that data accessible through simple URLs.

---

## Requirements

- Node.js >= 16.0.0
- npm

---

## Installation

```bash
# 1. Clone or download the project
git clone <your-repo-url>
cd rcsb-pdb-server

# 2. Install dependencies
npm install

# 3. Start the server
npm start

# For development (auto-restarts on file change)
npm run dev
```

Server runs at: `http://localhost:3000`

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | ^4.18.2 | Web server framework — handles routes and HTTP requests |
| `axios` | ^1.6.2 | HTTP client — makes requests to RCSB PDB APIs |
| `nodemon` *(dev)* | ^3.0.2 | Auto-restarts server during development |

---

## API Routes

### `GET /`
Health check — confirms server is running.

```
http://localhost:3000/
```

---

### `GET /metabolite/:id`
Fetches name, formula, and molecular weight of a metabolite/ligand.

Uses: **RCSB Data API** → `https://data.rcsb.org/rest/v1/core/chemcomp/:id`

```
http://localhost:3000/metabolite/ATP
http://localhost:3000/metabolite/HEM
http://localhost:3000/metabolite/QUE
```

**Response:**
```json
{
  "ligandId": "ATP",
  "name": "ADENOSINE-5'-TRIPHOSPHATE",
  "formula": "C10 H16 N5 O13 P3",
  "molecularWeight": 507.181
}
```

---

### `GET /metabolite/:id/proteins`
Finds all protein structures that physically contain the metabolite.

Uses: **RCSB Search API** → `https://search.rcsb.org/rcsbsearch/v2/query`

```
http://localhost:3000/metabolite/ATP/proteins
```

#### Query Parameters (all optional)

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `limit` | number | How many results to return (default: 25) | `?limit=100` |
| `organism` | string | Filter by scientific organism name | `?organism=Homo sapiens` |
| `keyword` | string | Filter by word in structure title | `?keyword=kinase` |
| `gene` | string | Filter by official gene name | `?gene=EGFR` |

**Examples:**
```
# Basic — 25 results
/metabolite/ATP/proteins

# Get 100 results
/metabolite/ATP/proteins?limit=100

# Human proteins only
/metabolite/ATP/proteins?organism=Homo sapiens

# Kinase proteins only
/metabolite/ATP/proteins?keyword=kinase

# By gene name
/metabolite/ATP/proteins?gene=EGFR

# Combine filters
/metabolite/ATP/proteins?organism=Homo sapiens&keyword=kinase&limit=50
/metabolite/ATP/proteins?gene=EGFR&organism=Homo sapiens&limit=20
```

**Response:**
```json
{
  "ligand": "ATP",
  "filters": { "organism": "Homo sapiens", "keyword": "kinase", "limit": 25 },
  "totalAvailable": 312,
  "totalReturned": 25,
  "proteins": [
    {
      "pdbId": "1ATP",
      "image": "https://cdn.rcsb.org/images/structures/1atp_assembly-1.jpeg",
      "rcsbLink": "https://www.rcsb.org/structure/1ATP"
    }
  ]
}
```

---

### `GET /search`
General keyword search across all RCSB PDB structures — no ligand required.

Uses: **RCSB Search API** (full_text, title, gene, or disease fields)

#### Query Parameters

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `keyword` | string | **(Required)** Word to search | `?keyword=insulin` |
| `field` | string | Where to search (default: `full_text`) | `?field=title` |
| `organism` | string | Filter by organism | `?organism=Homo sapiens` |
| `limit` | number | Results to return (default: 25) | `?limit=50` |

#### Field Options

| `field=` | Searches In | Best For |
|----------|-------------|---------|
| `full_text` *(default)* | All text fields at once | General exploration |
| `title` | Structure title only | Protein function words |
| `gene` | Official gene name | Known genes like TP53, ACE2 |
| `disease` | Disease association | Cancer, diabetes etc. |

**Examples:**
```
# General search
/search?keyword=insulin
/search?keyword=covid spike protein

# Search in title only
/search?keyword=kinase&field=title

# Search by gene name
/search?keyword=TP53&field=gene
/search?keyword=BRCA1&field=gene
/search?keyword=ACE2&field=gene

# Search by disease
/search?keyword=cancer&field=disease
/search?keyword=alzheimer&field=disease

# With organism filter
/search?keyword=photosynthesis&organism=Arabidopsis thaliana
/search?keyword=kinase&organism=Homo sapiens&limit=50
```

---

### `GET /metabolite/:id/structure`
Returns the 3D atomic coordinates of a metabolite in SDF format.

Uses: **RCSB ModelServer** → `https://models.rcsb.org/v1/:id/ligand`

```
http://localhost:3000/metabolite/ATP/structure
http://localhost:3000/metabolite/QUE/structure
```

Returns a `.sdf` file (plain text). Paste the output into:
- https://molview.org
- https://www.rcsb.org/3d-view
- Avogadro, Jmol, or ChemDraw (desktop apps)

---

## Metabolite Codes to Try

| Code | Name | Source | Known For |
|------|------|--------|-----------|
| `ATP` | Adenosine Triphosphate | All living cells | Energy currency |
| `HEM` | Heme | Red blood cells | Oxygen transport |
| `NAD` | NAD+ | All cells | Energy metabolism |
| `QUE` | Quercetin | Onion, Apple | Antioxidant |
| `CU1` | Curcumin | Turmeric | Anti-inflammatory |
| `RSV` | Resveratrol | Grapes | Heart health |
| `CFF` | Caffeine | Coffee, Tea | Stimulant |
| `NIC` | Nicotine | Tobacco | Stimulant |
| `ZN` | Zinc ion | Many plants | Cofactor |
| `CLA` | Chlorophyll | All green plants | Photosynthesis |

---

## Organism Names to Use

| Common Name | Use in URL |
|-------------|-----------|
| Human | `Homo sapiens` |
| Mouse | `Mus musculus` |
| E. coli | `Escherichia coli` |
| Yeast | `Saccharomyces cerevisiae` |
| Arabidopsis (plant) | `Arabidopsis thaliana` |
| Rice | `Oryza sativa` |
| Rat | `Rattus norvegicus` |

---

## Gene Names to Try

| Gene | What It Is | Disease |
|------|-----------|---------|
| `TP53` | Tumor suppressor | Cancer |
| `BRCA1` | DNA repair | Breast cancer |
| `EGFR` | Growth factor receptor | Lung cancer |
| `ACE2` | COVID entry receptor | COVID-19 |
| `INS` | Insulin gene | Diabetes |
| `KRAS` | Cell signaling | Pancreatic cancer |
| `HBB` | Hemoglobin beta | Sickle cell anemia |

---

## APIs Used

| API | URL | Purpose |
|-----|-----|---------|
| RCSB Data API | `data.rcsb.org/rest/v1` | Get metabolite name, formula, weight |
| RCSB Search API | `search.rcsb.org/rcsbsearch/v2/query` | Search and filter protein structures |
| RCSB ModelServer | `models.rcsb.org/v1` | Get 3D coordinate files (SDF) |
| RCSB CDN | `cdn.rcsb.org/images/structures` | Pre-rendered structure images |

All APIs are **free** and require **no API key**.

---

## Route vs Route: When to Use Which

```
/metabolite/ATP/proteins?filters
    → Use when: you care about a SPECIFIC LIGAND being present
    → Finds: proteins that physically have ATP bound to them
    → Best for: ligand-protein interaction research

/search?keyword=kinase
    → Use when: you want broad exploration, no specific ligand
    → Finds: all structures mentioning the keyword anywhere
    → Best for: general topic research
```

---

## Error Responses

| Status | Message | Reason |
|--------|---------|--------|
| `404` | Ligand not found | Invalid metabolite code |
| `400` | Please provide a keyword | Missing keyword in /search |
| `500` | Search failed | RCSB API error — check details field |

---

## Project Structure

```
rcsb-pdb-server/
│
├── index.js          ← main server file (all routes)
├── package.json      ← dependencies and scripts
└── README.md         ← this file
```

---

## License

MIT