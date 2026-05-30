const express = require("express");
const axios   = require("axios");
const path    = require("path");

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
// GET /metabolite/:id/proteins
// ─────────────────────────────────────────────────────────────
app.get("/metabolite/:id/proteins", async (req, res) => {
    try {
        const ligandId         = req.params.id.toUpperCase();
        const limit            = parseInt(req.query.limit)            || 100;
        const start            = parseInt(req.query.start)            || 0;
        const organism         = req.query.organism                   || null;
        const keyword          = req.query.keyword                    || null;
        const experimentMethod = req.query.experimentMethod           || null;

        let query = {
            query: {
                type:             "group",
                logical_operator: "and",
                label:            "text",
                nodes: [
                    {
                        type:    "terminal",
                        service: "full_text",
                        parameters: {
                            value: ligandId
                        }
                    }
                ]
            },
            return_type: "entry",
            request_options: {
                paginate: {
                    start: start,
                    rows:  limit
                },
                results_content_type: ["experimental"],
                sort: [
                    {
                        sort_by:   "score",
                        direction: "desc"
                    }
                ],
                scoring_strategy: "combined"
            }
        };

        // ── always-present protein type node ──────────────────
        const proteinNode = {
            type:    "terminal",
            service: "text",
            parameters: {
                attribute: "entity_poly.rcsb_entity_polymer_type",
                operator:  "exact_match",
                value:     "Protein"
            }
        };

        // ── build __refinements__ group if any filter present ──
        if (organism || experimentMethod) {
            const refinementNodes = [proteinNode];

            if (organism) {
                refinementNodes.push({
                    type:    "terminal",
                    service: "text",
                    parameters: {
                        attribute: "rcsb_entity_source_organism.ncbi_scientific_name",
                        operator:  "exact_match",
                        value:     organism
                    }
                });
            }

            if (experimentMethod) {
                refinementNodes.push({
                    type:    "terminal",
                    service: "text",
                    parameters: {
                        attribute: "exptl.method",
                        operator:  "exact_match",
                        value:     experimentMethod.toUpperCase()
                    }
                });
            }

            query.query.nodes.push({
                type:             "group",
                label:            "__refinements__",
                logical_operator: "and",
                nodes:            refinementNodes
            });

        } else {
            query.query.nodes.push(proteinNode);
        }

        // ── keyword: full-text search ──────────────────────────
        if (keyword) {
            query.query.nodes.push({
                type:    "terminal",
                service: "full_text",
                parameters: {
                    value: keyword
                }
            });
        }

        const response = await axios.post(
            "https://search.rcsb.org/rcsbsearch/v2/query",
            query,
            { headers: { "Content-Type": "application/json" } }
        );

        if (response.status === 204) {
            return res.json({
                ligand:         ligandId,
                filters:        { organism, keyword, experimentMethod, limit },
                totalAvailable: 0,
                totalReturned:  0,
                proteins:       []
            });
        }

        const totalCount = response.data.total_count;

        if (!response.data.result_set || response.data.result_set.length === 0) {
            return res.json({
                ligand:         ligandId,
                filters:        { organism, keyword, experimentMethod, limit },
                totalAvailable: totalCount || 0,
                totalReturned:  0,
                proteins:       []
            });
        }

        const proteins = response.data.result_set.map(item => {
            const pdbId = item.identifier;
            return {
                pdbId,
                image:    `https://cdn.rcsb.org/images/structures/${pdbId.toLowerCase()}_assembly-1.jpeg`,
                rcsbLink: `https://www.rcsb.org/structure/${pdbId}`
            };
        });

        res.json({
            ligand:         ligandId,
            filters:        { organism, keyword, experimentMethod, limit },
            totalAvailable: totalCount,
            totalReturned:  proteins.length,
            proteins
        });

    } catch (error) {
        console.log("Status:", error.response?.status);
        console.log("Error:",  JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({
            error:   "Search failed",
            details: error.response?.data
        });
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
            return res.status(400).json({
                error: "Please provide a keyword.",
                examples: [
                    "/search?keyword=kinase",
                    "/search?keyword=TP53&field=gene",
                    "/search?keyword=insulin&organism=Homo sapiens"
                ]
            });
        }

        let keywordCondition;

        if (field === "full_text") {
            keywordCondition = {
                type:    "terminal",
                service: "full_text",
                parameters: { value: keyword }
            };
        } else if (field === "title") {
            keywordCondition = {
                type:    "terminal",
                service: "text",
                parameters: {
                    attribute: "struct.title",
                    operator:  "contains_words",
                    value:     keyword
                }
            };
        } else if (field === "gene") {
            keywordCondition = {
                type:    "terminal",
                service: "text",
                parameters: {
                    attribute:      "rcsb_entity_source_organism.rcsb_gene_name.value",
                    operator:       "exact_match",
                    value:          keyword.toUpperCase(),
                    case_sensitive: true
                }
            };
        } else if (field === "disease") {
            keywordCondition = {
                type:    "terminal",
                service: "text",
                parameters: {
                    attribute: "rcsb_related_target_references.target_name",
                    operator:  "contains_words",
                    value:     keyword
                }
            };
        } else {
            keywordCondition = {
                type:    "terminal",
                service: "full_text",
                parameters: { value: keyword }
            };
        }

        const conditions = [keywordCondition];

        if (organism) {
            conditions.push({
                type:    "terminal",
                service: "text",
                parameters: {
                    attribute: "rcsb_entity_source_organism.taxonomy_lineage.name",
                    operator:  "exact_match",
                    value:     organism
                }
            });
        }

        const query = {
            query: conditions.length === 1
                ? conditions[0]
                : {
                    type:             "group",
                    logical_operator: "and",
                    nodes:            conditions
                },
            return_type:     "entry",
            request_options: {
                paginate: { start: start, rows: limit }
            }
        };

        const response = await axios.post(
            "https://search.rcsb.org/rcsbsearch/v2/query",
            query,
            { headers: { "Content-Type": "application/json" } }
        );

        if (response.status === 204) {
            return res.json({ keyword, field, organism, totalAvailable: 0, results: [] });
        }

        const totalCount = response.data.total_count;

        if (!response.data.result_set || response.data.result_set.length === 0) {
            return res.json({ keyword, field, organism, totalAvailable: 0, results: [] });
        }

        const results = response.data.result_set.map(item => {
            const pdbId = item.identifier;
            return {
                pdbId,
                image:    `https://cdn.rcsb.org/images/structures/${pdbId.toLowerCase()}_assembly-1.jpeg`,
                rcsbLink: `https://www.rcsb.org/structure/${pdbId}`
            };
        });

        res.json({
            keyword,
            field,
            filters:        { organism, limit },
            totalAvailable: totalCount,
            totalReturned:  results.length,
            results
        });

    } catch (error) {
        console.log("Error:", JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({ error: "Search failed", details: error.response?.data });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /metabolite/:id/structure
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