const express  = require("express");
const axios    = require("axios");
const path     = require("path");
const archiver = require("archiver");
const { cifToPdb } = require("./cifToPdb");

const app  = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "views")));

app.use("/", (req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "index.html"));
});


// ─────────────────────────────────────────────────────────────
// HELPER: fetch CIF for one entry from ModelServer, with retry
// Uses assembly endpoint: models.rcsb.org/v1/{id}/assembly?name=1&encoding=cif
// Returns CIF string on success, null after all retries fail
// ─────────────────────────────────────────────────────────────
async function fetchCif(pdbId, retries = 3) {
    const url = `https://models.rcsb.org/v1/${pdbId.toLowerCase()}/assembly?name=1&encoding=cif&copy_all_categories=false&download=false`;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await axios.get(url, {
                responseType: "text",
                timeout: 60000
            });
            return res.data;
        } catch (err) {
            console.log(`  ${pdbId} CIF attempt ${attempt}/${retries}: ${err.message}`);
            if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    return null;
}


// ─────────────────────────────────────────────────────────────
// HELPER: fetch ALL pdb ids for a ligand with given filters
// Loops in batches of 1000 until every id is collected
// ─────────────────────────────────────────────────────────────
async function fetchAllPdbIds(ligandId, { organism, keyword, experimentMethod } = {}) {
    const BATCH = 1000;
    let start   = 0;
    let total   = null;
    let allIds  = [];

    while (true) {
        const request_options = {
            paginate: { start, rows: BATCH },
            results_content_type: ["experimental"],
            sort: [{ sort_by: "score", direction: "desc" }],
            scoring_strategy: "combined"
        };

        const proteinNode    = { type: "terminal", service: "text",      parameters: { attribute: "entity_poly.rcsb_entity_polymer_type", operator: "exact_match", value: "Protein" } };
        const ligandNode     = { type: "terminal", service: "full_text", parameters: { value: ligandId } };
        const keywordNode    = keyword          ? { type: "terminal", service: "full_text", parameters: { value: keyword } } : null;
        const organismNode   = organism         ? { type: "terminal", service: "text", parameters: { attribute: "rcsb_entity_source_organism.ncbi_scientific_name", operator: "exact_match", value: organism } } : null;
        const experimentNode = experimentMethod ? { type: "terminal", service: "text", parameters: { attribute: "exptl.method", operator: "exact_match", value: experimentMethod.toUpperCase() } } : null;

        let queryNode;
        if (!organism && !experimentMethod) {
            const nodes = [ligandNode, proteinNode];
            if (keywordNode) nodes.push(keywordNode);
            queryNode = { type: "group", logical_operator: "and", label: "text", nodes };
        } else {
            const refNodes = [proteinNode];
            if (organismNode)   refNodes.push(organismNode);
            if (experimentNode) refNodes.push(experimentNode);
            const nodes = [ligandNode, { type: "group", label: "__refinements__", logical_operator: "and", nodes: refNodes }];
            if (keywordNode) nodes.push(keywordNode);
            queryNode = { type: "group", logical_operator: "and", label: "text", nodes };
        }

        const response = await axios.post(
            "https://search.rcsb.org/rcsbsearch/v2/query",
            { query: queryNode, return_type: "entry", request_options },
            { headers: { "Content-Type": "application/json" } }
        );

        if (response.status === 204) break;
        if (total === null) total = response.data.total_count || 0;

        const batch = (response.data.result_set || []).map(item => item.identifier);
        allIds = [...allIds, ...batch];

        if (allIds.length >= total || batch.length === 0) break;
        start += BATCH;
    }

    return { ids: allIds, total: total || allIds.length };
}


// ─────────────────────────────────────────────────────────────
// GET /metabolite/:id
// ─────────────────────────────────────────────────────────────
app.get("/metabolite/:id", async (req, res) => {
    try {
        const ligandId = req.params.id.toUpperCase();
        const url      = `https://data.rcsb.org/rest/v1/core/chemcomp/${ligandId}`;
        const response = await axios.get(url);
        const data     = response.data;
        res.json({
            ligandId:        ligandId,
            name:            data.chem_comp.name,
            formula:         data.chem_comp.formula,
            molecularWeight: data.chem_comp.formula_weight
        });
    } catch (error) {
        res.status(404).json({ error: "Ligand not found" });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /metabolite/:id/proteins  (paginated, for the UI)
// ─────────────────────────────────────────────────────────────
app.get("/metabolite/:id/proteins", async (req, res) => {
    try {
        const ligandId         = req.params.id.toUpperCase();
        const limit            = parseInt(req.query.limit)   || 25;
        const start            = parseInt(req.query.start)   || 0;
        const organism         = req.query.organism          || null;
        const keyword          = req.query.keyword           || null;
        const experimentMethod = req.query.experimentMethod  || null;

        const request_options = {
            paginate: { start, rows: limit },
            results_content_type: ["experimental"],
            sort: [{ sort_by: "score", direction: "desc" }],
            scoring_strategy: "combined"
        };

        const proteinNode    = { type: "terminal", service: "text",      parameters: { attribute: "entity_poly.rcsb_entity_polymer_type", operator: "exact_match", value: "Protein" } };
        const ligandNode     = { type: "terminal", service: "full_text", parameters: { value: ligandId } };
        const keywordNode    = keyword          ? { type: "terminal", service: "full_text", parameters: { value: keyword } } : null;
        const orgNode        = organism         ? { type: "terminal", service: "text", parameters: { attribute: "rcsb_entity_source_organism.ncbi_scientific_name", operator: "exact_match", value: organism } } : null;
        const expNode        = experimentMethod ? { type: "terminal", service: "text", parameters: { attribute: "exptl.method", operator: "exact_match", value: experimentMethod.toUpperCase() } } : null;

        let queryNode;
        if (!organism && !experimentMethod) {
            const nodes = [ligandNode, proteinNode];
            if (keywordNode) nodes.push(keywordNode);
            queryNode = { type: "group", logical_operator: "and", label: "text", nodes };
        } else {
            const refNodes = [proteinNode];
            if (orgNode) refNodes.push(orgNode);
            if (expNode) refNodes.push(expNode);
            const nodes = [ligandNode, { type: "group", label: "__refinements__", logical_operator: "and", nodes: refNodes }];
            if (keywordNode) nodes.push(keywordNode);
            queryNode = { type: "group", logical_operator: "and", label: "text", nodes };
        }

        const response = await axios.post(
            "https://search.rcsb.org/rcsbsearch/v2/query",
            { query: queryNode, return_type: "entry", request_options },
            { headers: { "Content-Type": "application/json" } }
        );

        if (response.status === 204) {
            return res.json({ ligand: ligandId, filters: { organism, keyword, experimentMethod, limit }, totalAvailable: 0, totalReturned: 0, proteins: [] });
        }

        const totalCount = response.data.total_count;

        if (!response.data.result_set || response.data.result_set.length === 0) {
            return res.json({ ligand: ligandId, filters: { organism, keyword, experimentMethod, limit }, totalAvailable: totalCount || 0, totalReturned: 0, proteins: [] });
        }

        const proteins = response.data.result_set.map(item => {
            const pdbId = item.identifier;
            return { pdbId, image: `https://cdn.rcsb.org/images/structures/${pdbId.toLowerCase()}_assembly-1.jpeg`, rcsbLink: `https://www.rcsb.org/structure/${pdbId}` };
        });

        res.json({ ligand: ligandId, filters: { organism, keyword, experimentMethod, limit }, totalAvailable: totalCount, totalReturned: proteins.length, proteins });

    } catch (error) {
        console.log("Status:", error.response?.status);
        console.log("Error:",  JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({ error: "Search failed", details: error.response?.data });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /metabolite/:id/download/ids
// Returns a .txt file with ALL pdb ids, one per line
// ─────────────────────────────────────────────────────────────
app.get("/metabolite/:id/download/ids", async (req, res) => {
    try {
        const ligandId         = req.params.id.toUpperCase();
        const organism         = req.query.organism         || null;
        const keyword          = req.query.keyword          || null;
        const experimentMethod = req.query.experimentMethod || null;

        console.log(`Fetching ALL ids for ${ligandId}...`);
        const { ids, total } = await fetchAllPdbIds(ligandId, { organism, keyword, experimentMethod });

        if (ids.length === 0) {
            return res.status(404).json({ error: "No results found" });
        }

        const content = ids.join("\n");

        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Disposition", `attachment; filename="${ligandId}_pdb_ids.txt"`);
        res.send(content);

    } catch (error) {
        console.log("Download IDs error:", error.message);
        res.status(500).json({ error: "Failed to fetch IDs", details: error.message });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /metabolite/:id/download/structures
//
// For each PDB entry:
//   1. Fetch assembly CIF from ModelServer (models.rcsb.org)
//   2. Parse _atom_site loop
//   3. Keep only: chain A | ATOM records | no water | no ions | no HETATM
//   4. Write as PDB-format text
//   5. Pack all .pdb files into a single zip
//
// Batches of 5 with retry + 300 ms inter-batch delay to respect rate limits
// ─────────────────────────────────────────────────────────────
app.get("/metabolite/:id/download/structures", async (req, res) => {
    try {
        const ligandId         = req.params.id.toUpperCase();
        const organism         = req.query.organism         || null;
        const keyword          = req.query.keyword          || null;
        const experimentMethod = req.query.experimentMethod || null;

        console.log(`Fetching ALL ids for ${ligandId}...`);
        const { ids, total } = await fetchAllPdbIds(ligandId, { organism, keyword, experimentMethod });

        if (ids.length === 0) {
            return res.status(404).json({ error: "No results found with these filters." });
        }

        console.log(`Found ${total} structures. Fetching CIFs and building zip...`);

        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${ligandId}_chainA_structures.zip"`);
        res.setHeader("Transfer-Encoding", "chunked");

        const archive = archiver("zip", { zlib: { level: 1 } });
        archive.on("error",   err => console.log("Archiver error:",   err.message));
        archive.on("warning", err => console.log("Archiver warning:", err.message));
        archive.pipe(res);

        const BATCH_SIZE = 5;
        let   done       = 0;
        const failed     = [];
        const skipped    = [];   // entries where chain A had 0 atoms after filtering

        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            const batch = ids.slice(i, i + BATCH_SIZE);

            const results = await Promise.all(
                batch.map(async (pdbId) => {
                    const cifText = await fetchCif(pdbId, 3);
                    return { pdbId, cifText };
                })
            );

            for (const { pdbId, cifText } of results) {
                if (!cifText) {
                    failed.push(pdbId);
                    archive.append(
                        Buffer.from(`Could not download CIF after 3 attempts.`),
                        { name: `${pdbId}_FAILED.txt` }
                    );
                    console.log(`[FAILED]   ${pdbId}`);
                    continue;
                }

                const pdbText = cifToPdb(cifText, pdbId);

                if (!pdbText) {
                    skipped.push(pdbId);
                    console.log(`[SKIPPED]  ${pdbId} – no chain-A protein atoms found`);
                    continue;
                }

                archive.append(Buffer.from(pdbText), { name: `${pdbId}_chainA.pdb` });
                done++;
                console.log(`[${done}/${total}] ${pdbId}_chainA.pdb added`);
            }

            // Polite delay between batches
            if (i + BATCH_SIZE < ids.length) {
                await new Promise(r => setTimeout(r, 300));
            }
        }

        // Summary files
        if (failed.length > 0) {
            archive.append(
                Buffer.from(`These ${failed.length} entries could not be downloaded:\n${failed.join("\n")}`),
                { name: "FAILED_DOWNLOADS.txt" }
            );
        }
        if (skipped.length > 0) {
            archive.append(
                Buffer.from(`These ${skipped.length} entries had no chain-A protein atoms:\n${skipped.join("\n")}`),
                { name: "SKIPPED_NO_CHAIN_A.txt" }
            );
        }

        await archive.finalize();
        console.log(`Done. ${done} PDB files written, ${failed.length} failed, ${skipped.length} skipped.`);

    } catch (error) {
        console.log("Download structures error:", error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to create zip", details: error.message });
        }
    }
});


// ─────────────────────────────────────────────────────────────
// GET /search
// ─────────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
    try {
        const keyword  = req.query.keyword  || null;
        const organism = req.query.organism || null;
        const field    = req.query.field    || "full_text";
        const limit    = parseInt(req.query.limit) || 25;
        const start    = parseInt(req.query.start) || 0;

        if (!keyword) {
            return res.status(400).json({ error: "Please provide a keyword." });
        }

        let keywordCondition;
        if (field === "full_text") {
            keywordCondition = { type: "terminal", service: "full_text", parameters: { value: keyword } };
        } else if (field === "title") {
            keywordCondition = { type: "terminal", service: "text", parameters: { attribute: "struct.title", operator: "contains_words", value: keyword } };
        } else if (field === "gene") {
            keywordCondition = { type: "terminal", service: "text", parameters: { attribute: "rcsb_entity_source_organism.rcsb_gene_name.value", operator: "exact_match", value: keyword.toUpperCase(), case_sensitive: true } };
        } else if (field === "disease") {
            keywordCondition = { type: "terminal", service: "text", parameters: { attribute: "rcsb_related_target_references.target_name", operator: "contains_words", value: keyword } };
        } else {
            keywordCondition = { type: "terminal", service: "full_text", parameters: { value: keyword } };
        }

        const conditions = [keywordCondition];
        if (organism) {
            conditions.push({ type: "terminal", service: "text", parameters: { attribute: "rcsb_entity_source_organism.taxonomy_lineage.name", operator: "exact_match", value: organism } });
        }

        const query = {
            query: conditions.length === 1 ? conditions[0] : { type: "group", logical_operator: "and", nodes: conditions },
            return_type: "entry",
            request_options: { paginate: { start, rows: limit } }
        };

        const response = await axios.post(
            "https://search.rcsb.org/rcsbsearch/v2/query", query,
            { headers: { "Content-Type": "application/json" } }
        );

        if (response.status === 204) return res.json({ keyword, field, organism, totalAvailable: 0, results: [] });

        const totalCount = response.data.total_count;
        if (!response.data.result_set || response.data.result_set.length === 0) {
            return res.json({ keyword, field, organism, totalAvailable: 0, results: [] });
        }

        const results = response.data.result_set.map(item => {
            const pdbId = item.identifier;
            return { pdbId, image: `https://cdn.rcsb.org/images/structures/${pdbId.toLowerCase()}_assembly-1.jpeg`, rcsbLink: `https://www.rcsb.org/structure/${pdbId}` };
        });

        res.json({ keyword, field, filters: { organism, limit }, totalAvailable: totalCount, totalReturned: results.length, results });

    } catch (error) {
        console.log("Error:", JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({ error: "Search failed", details: error.response?.data });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /metabolite/:id/structure  (single metabolite SDF)
// ─────────────────────────────────────────────────────────────
app.get("/metabolite/:id/structure", async (req, res) => {
    try {
        const ligandId = req.params.id.toUpperCase();
        const url      = `https://models.rcsb.org/v1/${ligandId}/ligand?auth_comp_id=${ligandId}&encoding=sdf`;
        const response = await axios.get(url);
        res.setHeader("Content-Type", "text/plain");
        res.send(response.data);
    } catch (error) {
        res.status(404).json({ error: "Structure not found" });
    }
});


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open: http://localhost:${PORT}`);
});