const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.static('views')); // Serve static files from the "views" directory
const PORT = 3000;

app.get("/", (req, res) => {
    res.send("RCSB PDB Server Running");
});

app.get("/metabolite/:id", async (req, res) => {
    try {
        const ligandId = req.params.id.toUpperCase();
        const url = `https://data.rcsb.org/rest/v1/core/chemcomp/${ligandId}`;
        const response = await axios.get(url);
        const data = response.data;

        res.json({
            ligandId: ligandId,
            name: data.chem_comp.name,
            formula: data.chem_comp.formula,
            molecularWeight: data.chem_comp.formula_weight
        });

    } catch (error) {
        res.status(404).json({ error: "Ligand not found" });
    }
});


// ─────────────────────────────────────────────────────────────
// PROTEINS ROUTE — with organism filter + keyword filter
//
// linked to /metabolite/:id/proteins
// Returns proteins that contain the specified ligand, with optional filters for organism and keyword in title.
//
// Examples:
// /metabolite/ATP/proteins
// /metabolite/ATP/proteins?limit=50
// /metabolite/ATP/proteins?organism=Homo sapiens
// /metabolite/ATP/proteins?keyword=kinase
// /metabolite/ATP/proteins?organism=Homo sapiens&keyword=kinase&limit=20
// ─────────────────────────────────────────────────────────────
app.get("/metabolite/:id/proteins", async (req, res) => {
    try {
        const ligandId  = req.params.id.toUpperCase();
        const limit     = parseInt(req.query.limit)    || 100;
        const organism  = req.query.organisms         || null; 
        const keyword   = req.query.keyword            || null; 

        // ── Build search conditions ──────────────────────────
        // We always search by ligand ID
        // If organism or keyword provided, we add them as extra conditions

        const conditions = [
            {
                type: "terminal",
                service: "text",
                parameters: {
                    attribute: "rcsb_nonpolymer_entity_instance_container_identifiers.comp_id",
                    operator: "exact_match",
                    value: ligandId
                }
            }
        ];

        // Add organism filter if provided
        // This filters by the scientific name of the source organism
        if (organism) {
            conditions.push({
                type: "terminal",
                service: "text",
                parameters: {
                    attribute: "rcsb_entity_source_organism.scientific_name",
                    operator: "exact_match",
                    value: organism         // e.g. "Homo sapiens", "Mus musculus"
                }
            });
        }

        // Add keyword filter if provided
        // This searches in the protein title/description
        if (keyword) {
            conditions.push({
                type: "terminal",
                service: "text",
                parameters: {
                    attribute: "struct.title",
                    operator: "contains_words",
                    value: keyword          // e.g. "kinase", "receptor", "synthase"
                }
            });
        }

        // ── Build final query ────────────────────────────────
        // If only one condition → use it directly (terminal)
        // If multiple conditions → wrap in "and" group
        const query = {
            query: conditions.length === 1
                ? conditions[0]             // single condition, no group needed
                : {
                    type: "group",
                    logical_operator: "and", // ALL conditions must match
                    nodes: conditions
                },

            return_type: "entry",
            request_options: {
                paginate: { start: 0, rows: limit }
            }
        };

        const response = await axios.post(
            "https://search.rcsb.org/rcsbsearch/v2/query",
            query,
            { headers: { "Content-Type": "application/json" } }
        );

        const totalCount = response.data.total_count;

        if (!response.data.result_set || response.data.result_set.length === 0) {
            return res.json({
                ligand: ligandId,
                filters: { organism, keyword },
                totalAvailable: totalCount || 0,
                totalReturned: 0,
                proteins: []
            });
        }

        const proteins = response.data.result_set.map(item => {
            const pdbId = item.identifier;
            return {
                pdbId,
                image: `https://cdn.rcsb.org/images/structures/${pdbId.toLowerCase()}_assembly-1.jpeg`,
                rcsbLink: `https://www.rcsb.org/structure/${pdbId}`  // direct link to RCSB page
            };
        });

        res.json({
            ligand: ligandId,
            filters: { organism, keyword, limit },  // show what filters were applied
            totalAvailable: totalCount,
            totalReturned: proteins.length,
            proteins
        });

    } catch (error) {
        console.log("Status:", error.response?.status);
        console.log("Error:", JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({
            error: "Search failed",
            details: error.response?.data
        });
    }
});


// ─────────────────────────────────────────────────────────────
// KEYWORD SEARCH ROUTE — search proteins by any keyword
// Does not need a ligand — just search by word
//
// Examples:
// /search?keyword=insulin
// /search?keyword=covid protease
// /search?keyword=photosynthesis&organism=Arabidopsis thaliana
// ─────────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
    try {
        const keyword   = req.query.keyword  || null;
        const organism  = req.query.organism || null;
        const limit     = parseInt(req.query.limit) || 25;

        if (!keyword) {
            return res.status(400).json({
                error: "Please provide a keyword. Example: /search?keyword=kinase"
            });
        }

        const conditions = [
            {
                type: "terminal",
                service: "text",
                parameters: {
                    attribute: "struct.title",
                    operator: "contains_words",
                    value: keyword
                }
            }
        ];

        if (organism) {
            conditions.push({
                type: "terminal",
                service: "text",
                parameters: {
                    attribute: "rcsb_entity_source_organism.scientific_name",
                    operator: "exact_match",
                    value: organism
                }
            });
        }

        const query = {
            query: conditions.length === 1
                ? conditions[0]
                : {
                    type: "group",
                    logical_operator: "and",
                    nodes: conditions
                },
            return_type: "entry",
            request_options: {
                paginate: { start: 0, rows: limit }
            }
        };

        const response = await axios.post(
            "https://search.rcsb.org/rcsbsearch/v2/query",
            query,
            { headers: { "Content-Type": "application/json" } }
        );

        const totalCount = response.data.total_count;

        if (!response.data.result_set || response.data.result_set.length === 0) {
            return res.json({
                keyword,
                organism,
                totalAvailable: 0,
                results: []
            });
        }

        const results = response.data.result_set.map(item => {
            const pdbId = item.identifier;
            return {
                pdbId,
                image: `https://cdn.rcsb.org/images/structures/${pdbId.toLowerCase()}_assembly-1.jpeg`,
                rcsbLink: `https://www.rcsb.org/structure/${pdbId}`
            };
        });

        res.json({
            keyword,
            filters: { organism, limit },
            totalAvailable: totalCount,
            totalReturned: results.length,
            results
        });

    } catch (error) {
        console.log("Error:", JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({ error: "Search failed", details: error.response?.data });
    }
});


app.get("/metabolite/:id/structure", async (req, res) => {
    try {
        const ligandId = req.params.id.toUpperCase();
        const url = `https://models.rcsb.org/v1/${ligandId}/ligand?auth_comp_id=${ligandId}&encoding=sdf`;
        const response = await axios.get(url);
        res.setHeader("Content-Type", "text/plain");
        res.send(response.data);
    } catch (error) {
        res.status(404).json({ error: "Structure not found" });
    }
});


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});