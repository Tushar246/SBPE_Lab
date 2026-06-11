/**
 * PDBextractor — Express server for RCSB PDB search and bulk downloads.
 *
 * Serves Explorer.html as the single UI. All search/download traffic goes
 * through /universal/* routes backed by the RCSB Search API, GraphQL, and
 * ModelServer.
 */

const express  = require("express");
const axios    = require("axios");
const path     = require("path");
const archiver = require("archiver");
const { cifToPdb } = require("./Ciftopdb");

const app  = express();
const PORT = 3000;

app.use((req, _res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

// Register home routes BEFORE express.static — otherwise Index.html in views/
// is served at / and overrides this handler (Windows is case-insensitive).
app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "views", "Explorer.html"));
});

app.get(["/Index.html", "/index.html"], (_req, res) => {
    res.redirect("/");
});

app.use(express.static(path.join(__dirname, "views")));


// ── RCSB Search: build query node for universal full-text search ─────────────

function buildUniversalQuery(q, { organism, experimentMethod } = {}) {
    const searchNode = {
        type: "terminal", service: "full_text",
        parameters: { value: q }
    };

    const proteinNode = {
        type: "terminal", service: "text",
        parameters: {
            attribute: "entity_poly.rcsb_entity_polymer_type",
            operator: "exact_match",
            value: "Protein"
        }
    };

    const orgNode = organism ? {
        type: "terminal", service: "text",
        parameters: {
            attribute: "rcsb_entity_source_organism.ncbi_scientific_name",
            operator: "exact_match",
            value: organism
        }
    } : null;

    const expNode = experimentMethod ? {
        type: "terminal", service: "text",
        parameters: {
            attribute: "exptl.method",
            operator: "exact_match",
            value: experimentMethod.toUpperCase()
        }
    } : null;

    if (!organism && !experimentMethod) {
        return {
            type: "group", logical_operator: "and", label: "text",
            nodes: [searchNode, proteinNode]
        };
    }

    const refNodes = [proteinNode];
    if (orgNode) refNodes.push(orgNode);
    if (expNode) refNodes.push(expNode);

    return {
        type: "group", logical_operator: "and", label: "text",
        nodes: [
            searchNode,
            { type: "group", label: "__refinements__", logical_operator: "and", nodes: refNodes }
        ]
    };
}


// ── RCSB Search: paginate through every matching PDB entry ID ────────────────

async function fetchAllUniversalIds(q, { organism, experimentMethod } = {}) {
    const BATCH = 1000;
    let start   = 0;
    let total   = null;
    let allIds  = [];

    while (true) {
        const response = await axios.post(
            "https://search.rcsb.org/rcsbsearch/v2/query",
            {
                query: buildUniversalQuery(q, { organism, experimentMethod }),
                return_type: "entry",
                request_options: {
                    paginate: { start, rows: BATCH },
                    results_content_type: ["experimental"],
                    sort: [{ sort_by: "score", direction: "desc" }],
                    scoring_strategy: "combined"
                }
            },
            { headers: { "Content-Type": "application/json" } }
        );

        if (response.status === 204) break;
        if (total === null) total = response.data.total_count || 0;

        const batch = (response.data.result_set || []).map(item => item.identifier);
        allIds = allIds.concat(batch);

        if (allIds.length >= total || batch.length === 0) break;
        start += BATCH;
    }

    return { ids: allIds, total: total || allIds.length };
}


// ── ModelServer: fetch mmCIF for one entry (retries on transient failure) ───

async function fetchCif(pdbId, retries = 3) {
    const url = `https://models.rcsb.org/v1/${pdbId.toLowerCase()}/assembly?name=1&encoding=cif&copy_all_categories=false&download=false`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await axios.get(url, { responseType: "text", timeout: 60000 });
            return res.data;
        } catch (err) {
            console.log(`  ${pdbId} CIF attempt ${attempt}/${retries}: ${err.message}`);
            if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    return null;
}


// ── RCSB: fetch FASTA text for one entry ─────────────────────────────────────

async function fetchFasta(pdbId, retries = 3) {
    const url = `https://www.rcsb.org/fasta/entry/${pdbId.toLowerCase()}/display`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await axios.get(url, { responseType: "text", timeout: 30000 });
            if (res.data && res.data.trim()) return res.data;
        } catch (err) {
            console.log(`  ${pdbId} FASTA attempt ${attempt}/${retries}: ${err.message}`);
            if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    return null;
}


// ── Download helpers: stream zip archives to the response ────────────────────

async function streamStructuresZip(res, ids, total, zipFilename) {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);
    res.setHeader("Transfer-Encoding", "chunked");

    const archive = archiver("zip", { zlib: { level: 1 } });
    archive.on("error",   err => console.log("Archiver error:",   err.message));
    archive.on("warning", err => console.log("Archiver warning:", err.message));
    archive.pipe(res);

    const BATCH_SIZE = 5;
    let done = 0;
    const failed  = [];
    const skipped = [];

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(
            batch.map(async pdbId => ({ pdbId, cifText: await fetchCif(pdbId, 3) }))
        );

        for (const { pdbId, cifText } of results) {
            if (!cifText) {
                failed.push(pdbId);
                archive.append(
                    Buffer.from("Could not download CIF after 3 attempts."),
                    { name: `${pdbId}_FAILED.txt` }
                );
                continue;
            }

            const pdbText = cifToPdb(cifText, pdbId);
            if (!pdbText) {
                skipped.push(pdbId);
                continue;
            }

            archive.append(Buffer.from(pdbText), { name: `${pdbId}_chainA.pdb` });
            done++;
            console.log(`[structures ${done}/${total}] ${pdbId}_chainA.pdb`);
        }

        if (i + BATCH_SIZE < ids.length) await new Promise(r => setTimeout(r, 300));
    }

    if (failed.length > 0) {
        archive.append(
            Buffer.from(`Failed (${failed.length}):\n${failed.join("\n")}`),
            { name: "FAILED_DOWNLOADS.txt" }
        );
    }
    if (skipped.length > 0) {
        archive.append(
            Buffer.from(`Skipped — no chain-A protein atoms (${skipped.length}):\n${skipped.join("\n")}`),
            { name: "SKIPPED_NO_CHAIN_A.txt" }
        );
    }

    await archive.finalize();
    console.log(`Structures zip done: ${done} written, ${failed.length} failed, ${skipped.length} skipped.`);
}


async function streamFastaZip(res, ids, total, zipFilename) {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);
    res.setHeader("Transfer-Encoding", "chunked");

    const archive = archiver("zip", { zlib: { level: 1 } });
    archive.on("error", err => console.log("Archiver error:", err.message));
    archive.pipe(res);

    const BATCH_SIZE = 10;
    let done = 0;
    const failed = [];

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(
            batch.map(async pdbId => ({ pdbId, fasta: await fetchFasta(pdbId, 3) }))
        );

        for (const { pdbId, fasta } of results) {
            if (!fasta) {
                failed.push(pdbId);
                archive.append(
                    Buffer.from("Could not download FASTA after 3 attempts."),
                    { name: `${pdbId}_FAILED.txt` }
                );
                continue;
            }

            archive.append(Buffer.from(fasta), { name: `${pdbId}.fasta` });
            done++;
            console.log(`[fasta ${done}/${total}] ${pdbId}.fasta`);
        }

        if (i + BATCH_SIZE < ids.length) await new Promise(r => setTimeout(r, 200));
    }

    if (failed.length > 0) {
        archive.append(
            Buffer.from(`Failed (${failed.length}):\n${failed.join("\n")}`),
            { name: "FAILED_DOWNLOADS.txt" }
        );
    }

    await archive.finalize();
    console.log(`FASTA zip done: ${done} written, ${failed.length} failed.`);
}


// ── GraphQL: fetch enriched metadata for a batch of entry IDs ────────────────

async function fetchEntriesMetadata(entryIds) {
    const graphqlQuery = `
    {
      entries(entry_ids: [${entryIds.map(id => `"${id}"`).join(",")}]) {
        rcsb_id
        struct { title }
        exptl { method }
        pubmed {
          rcsb_pubmed_container_identifiers { pubmed_id }
        }
        nonpolymer_entities {
          nonpolymer_comp { chem_comp { id name } }
        }
        polymer_entities {
          uniprots { rcsb_id }
          entity_poly { rcsb_mutation_count }
          rcsb_entity_source_organism { ncbi_scientific_name }
        }
      }
    }`;

    const result = await axios.post(
        "https://data.rcsb.org/graphql",
        { query: graphqlQuery },
        { headers: { "Content-Type": "application/json" } }
    );

    return result.data?.data?.entries || [];
}


function parseSearchFilters(query) {
    return {
        organism:         query.organism || null,
        experimentMethod: query.method   || null
    };
}


function safeFilenamePart(text) {
    return String(text).replace(/[^\w.-]+/g, "_");
}


// ═════════════════════════════════════════════════════════════════════════════
//  UNIVERSAL ROUTES — used by Explorer.html
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /universal/search?q=ATP&limit=25&start=0&organism=Homo+sapiens&method=X-RAY+DIFFRACTION
 * Paginated protein-structure search (full-text + optional filters).
 */
app.get("/universal/search", async (req, res) => {
    try {
        const q     = req.query.q || null;
        const limit = parseInt(req.query.limit, 10) || 25;
        const start = parseInt(req.query.start, 10) || 0;
        const filters = parseSearchFilters(req.query);

        if (!q) return res.status(400).json({ error: "Provide ?q= search term" });

        const response = await axios.post(
            "https://search.rcsb.org/rcsbsearch/v2/query",
            {
                query: buildUniversalQuery(q, filters),
                return_type: "entry",
                request_options: {
                    paginate: { start, rows: limit },
                    results_content_type: ["experimental"],
                    sort: [{ sort_by: "score", direction: "desc" }],
                    scoring_strategy: "combined"
                }
            },
            { headers: { "Content-Type": "application/json" } }
        );

        if (response.status === 204) {
            return res.json({ query: q, totalAvailable: 0, results: [] });
        }

        const totalCount = response.data.total_count || 0;
        const results = (response.data.result_set || []).map(item => ({
            pdbId:    item.identifier,
            score:    item.score,
            image:    `https://cdn.rcsb.org/images/structures/${item.identifier.toLowerCase()}_assembly-1.jpeg`,
            rcsbLink: `https://www.rcsb.org/structure/${item.identifier}`
        }));

        res.json({
            query: q,
            filters: { ...filters, limit },
            totalAvailable: totalCount,
            totalReturned: results.length,
            results
        });

    } catch (error) {
        console.log("Universal search error:", error.response?.status, JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({ error: "Search failed", details: error.response?.data });
    }
});


/**
 * GET /universal/entry/:pdbId
 * Enriched detail for one structure (ligands, UniProt, PubMed, methods, etc.).
 */
app.get("/universal/entry/:pdbId", async (req, res) => {
    try {
        const pdbId = req.params.pdbId.toUpperCase();

        const graphqlQuery = `
        {
          entry(entry_id: "${pdbId}") {
            struct { title }
            exptl { method }
            exptl_crystal_grow { pdbx_details temp pH }
            pubmed {
              rcsb_pubmed_container_identifiers { pubmed_id }
            }
            nonpolymer_entities {
              nonpolymer_comp {
                chem_comp { id name formula formula_weight }
              }
            }
            polymer_entities {
              rcsb_entity_source_organism { ncbi_scientific_name }
              entity_poly {
                rcsb_mutation_count
                rcsb_sample_sequence_length
              }
              uniprots { rcsb_id }
            }
          }
        }`;

        const response = await axios.post(
            "https://data.rcsb.org/graphql",
            { query: graphqlQuery },
            { headers: { "Content-Type": "application/json" } }
        );

        const entry = response.data?.data?.entry;
        if (!entry) return res.status(404).json({ error: `Entry ${pdbId} not found` });

        const ligands = (entry.nonpolymer_entities || [])
            .map(e => e?.nonpolymer_comp?.chem_comp)
            .filter(Boolean)
            .map(c => ({
                id:            c.id,
                name:          c.name,
                formula:       c.formula,
                formulaWeight: c.formula_weight
            }));

        const uniprotIds = [];
        (entry.polymer_entities || []).forEach(pe => {
            (pe.uniprots || []).forEach(u => {
                if (u.rcsb_id && !uniprotIds.includes(u.rcsb_id)) uniprotIds.push(u.rcsb_id);
            });
        });

        const pubmedId = entry.pubmed?.rcsb_pubmed_container_identifiers?.pubmed_id || null;
        const methods  = (entry.exptl || []).map(e => e.method).filter(Boolean);

        const crystalConditions = (entry.exptl_crystal_grow || [])
            .map(c => ({
                details: c.pdbx_details || null,
                temp:    c.temp         || null,
                pH:      c.pH           || null
            }))
            .filter(c => c.details || c.temp || c.pH);

        const mutationCount = (entry.polymer_entities || [])
            .map(pe => pe?.entity_poly?.rcsb_mutation_count || 0)
            .reduce((sum, n) => sum + n, 0);

        const organisms = [];
        (entry.polymer_entities || []).forEach(pe => {
            (pe.rcsb_entity_source_organism || []).forEach(o => {
                if (o.ncbi_scientific_name && !organisms.includes(o.ncbi_scientific_name)) {
                    organisms.push(o.ncbi_scientific_name);
                }
            });
        });

        res.json({
            pdbId,
            title:      entry.struct?.title || null,
            methods,
            organisms,
            ligands,
            uniprotIds,
            pubmedId,
            mutationCount,
            crystalConditions,
            rcsbLink:   `https://www.rcsb.org/structure/${pdbId}`,
            pubmedLink: pubmedId ? `https://pubmed.ncbi.nlm.nih.gov/${pubmedId}/` : null,
            image:      `https://cdn.rcsb.org/images/structures/${pdbId.toLowerCase()}_assembly-1.jpeg`
        });

    } catch (error) {
        console.log("Entry enrichment error:", error.message);
        res.status(500).json({ error: "Failed to fetch entry data", details: error.message });
    }
});


/** GET /universal/download/ids — all matching PDB IDs as plain text */
app.get("/universal/download/ids", async (req, res) => {
    try {
        const q = req.query.q || null;
        const filters = parseSearchFilters(req.query);
        if (!q) return res.status(400).send("Provide ?q= search term");

        console.log(`[download/ids] q="${q}"`);
        const { ids, total } = await fetchAllUniversalIds(q, filters);
        if (ids.length === 0) return res.status(404).send("No results found.");

        const content = [
            `# PDB IDs — Search: "${q}"`,
            `# Total: ${total}`,
            `# Filters: organism=${filters.organism || "any"} | method=${filters.experimentMethod || "any"}`,
            `# Generated: ${new Date().toISOString()}`,
            "",
            ...ids
        ].join("\n");

        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Disposition", `attachment; filename="search_${safeFilenamePart(q)}_pdb_ids.txt"`);
        res.send(content);

    } catch (error) {
        if (!res.headersSent) res.status(500).send("Failed: " + error.message);
    }
});


/** GET /universal/download/ligands — unique ligand IDs across all matching structures */
app.get("/universal/download/ligands", async (req, res) => {
    try {
        const q = req.query.q || null;
        const filters = parseSearchFilters(req.query);
        if (!q) return res.status(400).send("Provide ?q= search term");

        console.log(`[download/ligands] q="${q}"`);
        const { ids, total } = await fetchAllUniversalIds(q, filters);
        if (ids.length === 0) return res.status(404).send("No results found.");

        const ligandSet = new Set();
        const CHUNK_SIZE = 50;

        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk   = ids.slice(i, i + CHUNK_SIZE);
            const entries = await fetchEntriesMetadata(chunk);

            for (const entry of entries) {
                (entry.nonpolymer_entities || []).forEach(entity => {
                    const id = entity?.nonpolymer_comp?.chem_comp?.id;
                    if (id) ligandSet.add(id);
                });
            }

            console.log(`[download/ligands] processed ${Math.min(i + CHUNK_SIZE, ids.length)}/${ids.length} entries`);
        }

        const ligandIds = [...ligandSet].sort();

        const content = [
            `# Unique ligand IDs — Search: "${q}"`,
            `# Structures scanned: ${total}`,
            `# Unique ligands found: ${ligandIds.length}`,
            `# Filters: organism=${filters.organism || "any"} | method=${filters.experimentMethod || "any"}`,
            `# Generated: ${new Date().toISOString()}`,
            "",
            ...ligandIds
        ].join("\n");

        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Disposition", `attachment; filename="search_${safeFilenamePart(q)}_ligand_ids.txt"`);
        res.send(content);

    } catch (error) {
        console.log("Download ligands error:", error.message);
        if (!res.headersSent) res.status(500).send("Failed: " + error.message);
    }
});


/** GET /universal/download/fasta — FASTA sequences for all matching structures as zip */
app.get("/universal/download/fasta", async (req, res) => {
    try {
        const q = req.query.q || null;
        const filters = parseSearchFilters(req.query);
        if (!q) return res.status(400).send("Provide ?q= search term");

        console.log(`[download/fasta] q="${q}"`);
        const { ids, total } = await fetchAllUniversalIds(q, filters);
        if (ids.length === 0) return res.status(404).send("No results found.");

        console.log(`[download/fasta] ${total} entries — building zip...`);
        await streamFastaZip(res, ids, total, `search_${safeFilenamePart(q)}_fasta.zip`);

    } catch (error) {
        console.log("Download FASTA error:", error.message);
        if (!res.headersSent) res.status(500).send("Failed: " + error.message);
    }
});


/** GET /universal/download/structures — chain-A PDB files for all matching structures as zip */
app.get("/universal/download/structures", async (req, res) => {
    try {
        const q = req.query.q || null;
        const filters = parseSearchFilters(req.query);
        if (!q) return res.status(400).send("Provide ?q= search term");

        console.log(`[download/structures] q="${q}"`);
        const { ids, total } = await fetchAllUniversalIds(q, filters);
        if (ids.length === 0) return res.status(404).send("No results found.");

        console.log(`[download/structures] ${total} entries — building zip...`);
        await streamStructuresZip(res, ids, total, `search_${safeFilenamePart(q)}_structures.zip`);

    } catch (error) {
        if (!res.headersSent) res.status(500).send("Failed: " + error.message);
    }
});


/** GET /universal/download/metadata — CSV metadata for all matching structures */
app.get("/universal/download/metadata", async (req, res) => {
    try {
        const q = req.query.q || null;
        const filters = parseSearchFilters(req.query);
        if (!q) return res.status(400).send("Provide ?q= search term");

        console.log(`[download/metadata] q="${q}"`);
        const { ids } = await fetchAllUniversalIds(q, filters);
        if (ids.length === 0) return res.status(404).send("No results found.");

        const rows = [];
        const CHUNK_SIZE = 50;

        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk   = ids.slice(i, i + CHUNK_SIZE);
            const entries = await fetchEntriesMetadata(chunk);

            for (const entry of entries) {
                const ligands = (entry.nonpolymer_entities || [])
                    .map(x => x?.nonpolymer_comp?.chem_comp?.id)
                    .filter(Boolean);

                const uniprots = (entry.polymer_entities || [])
                    .flatMap(x => x.uniprots || [])
                    .map(x => x.rcsb_id)
                    .filter(Boolean);

                const organisms = (entry.polymer_entities || [])
                    .flatMap(x => x.rcsb_entity_source_organism || [])
                    .map(x => x.ncbi_scientific_name)
                    .filter(Boolean);

                const mutationCount = (entry.polymer_entities || [])
                    .reduce((sum, p) => sum + (p.entity_poly?.rcsb_mutation_count || 0), 0);

                rows.push({
                    pdbId:     entry.rcsb_id,
                    title:     entry.struct?.title || "",
                    ligands:   ligands.join(";"),
                    uniprots:  uniprots.join(";"),
                    pubmed:    entry.pubmed?.rcsb_pubmed_container_identifiers?.pubmed_id || "",
                    methods:   (entry.exptl || []).map(x => x.method).join(";"),
                    organisms: organisms.join(";"),
                    mutations: mutationCount
                });
            }
        }

        const csv = [
            ["PDB_ID", "TITLE", "LIGANDS", "UNIPROT_IDS", "PUBMED_ID", "METHODS", "ORGANISMS", "MUTATION_COUNT"].join(","),
            ...rows.map(r => [
                r.pdbId,
                `"${r.title.replace(/"/g, '""')}"`,
                `"${r.ligands}"`,
                `"${r.uniprots}"`,
                r.pubmed,
                `"${r.methods}"`,
                `"${r.organisms}"`,
                r.mutations
            ].join(","))
        ].join("\n");

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="${safeFilenamePart(q)}_metadata.csv"`);
        res.send(csv);

    } catch (err) {
        console.log("Download metadata error:", err.message);
        res.status(500).send(err.message);
    }
});


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open: http://localhost:${PORT}`);
});
