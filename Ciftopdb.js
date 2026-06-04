// ─────────────────────────────────────────────────────────────
// cifToPdb.js  –  pure-Node helper
// Parses mmCIF text, keeps only chain-A protein ATOM records
// (no water, no ions, no HETATM/ligands), returns PDB string
// ─────────────────────────────────────────────────────────────

const WATER_NAMES = new Set(['HOH','WAT','H2O','DOD','D2O','OHX']);

// Single-element ions + common small-molecule ions to exclude
// (anything appearing as HETATM is already excluded by group check,
//  but we keep this for ATOM edge-cases in some older entries)
const ION_NAMES = new Set([
    'ZN','MG','CA','FE','MN','CU','NI','CO','NA','K','CL','BR',
    'IOD','CD','HG','PB','AU','AG','PT','RU','RH','PD','OS','IR',
    'LI','SR','BA','CS','RB','SE','F','FE2','FE3','CU1','CU2',
    'SO4','PO4','NO3','CO3','ACT','EDO'
]);

/**
 * Tokenize a single mmCIF data line.
 * Handles single-quoted, double-quoted, and whitespace-separated tokens.
 */
function tokenize(line) {
    const tokens = [];
    let i = 0;
    while (i < line.length) {
        const c = line[i];
        if (c === ' ' || c === '\t') { i++; continue; }
        if (c === "'") {
            let j = i + 1;
            while (j < line.length && !(line[j] === "'" && (j+1 >= line.length || line[j+1] === ' ' || line[j+1] === '\t'))) j++;
            tokens.push(line.slice(i+1, j));
            i = j + 1;
        } else if (c === '"') {
            let j = i + 1;
            while (j < line.length && line[j] !== '"') j++;
            tokens.push(line.slice(i+1, j));
            i = j + 1;
        } else {
            let j = i;
            while (j < line.length && line[j] !== ' ' && line[j] !== '\t') j++;
            tokens.push(line.slice(i, j));
            i = j;
        }
    }
    return tokens;
}

/**
 * Parse _atom_site loop from mmCIF text.
 * Returns array of plain objects keyed by column name (without "_atom_site.").
 */
function parseCifAtomSite(cifText) {
    const lines = cifText.split(/\r?\n/);
    let inLoop   = false;
    let headers  = [];
    const atoms  = [];
    let i = 0;

    while (i < lines.length) {
        const raw  = lines[i];
        const line = raw.trim();

        // Detect start of a loop_ block that has _atom_site columns
        if (line === 'loop_') {
            const peek = [];
            let j = i + 1;
            while (j < lines.length && lines[j].trim().startsWith('_atom_site.')) {
                peek.push(lines[j].trim().slice('_atom_site.'.length));
                j++;
            }
            if (peek.length > 0) {
                inLoop  = true;
                headers = peek;
                i = j;          // skip header lines; i now points at first data line
                continue;
            }
        }

        if (inLoop) {
            // End of this atom_site loop
            if (line === '' || line === '#' || line.startsWith('_') || line === 'loop_') {
                inLoop = false;
                i++;
                continue;
            }
            // Skip semicolon-delimited multi-line values (rare in atom_site)
            if (line.startsWith(';')) {
                i++;
                while (i < lines.length && !lines[i].startsWith(';')) i++;
                i++;
                continue;
            }
            // Data row
            if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
                const tokens = tokenize(line);
                if (tokens.length >= headers.length) {
                    const atom = {};
                    headers.forEach((h, idx) => atom[h] = tokens[idx]);
                    atoms.push(atom);
                }
            }
        }

        i++;
    }

    return atoms;
}

/**
 * Filter: keep only chain A, standard amino-acid ATOM records.
 * Drops: HETATM, water, ions.
 */
function filterAtoms(atoms) {
    return atoms.filter(a => {
        if (a['group_PDB'] !== 'ATOM') return false;                    // drop HETATM/ligands
        const chain = (a['auth_asym_id'] || a['label_asym_id'] || '').trim();
        if (chain !== 'A') return false;                                 // chain A only
        const res = (a['auth_comp_id'] || a['label_comp_id'] || '').trim().toUpperCase();
        if (WATER_NAMES.has(res)) return false;                          // no water
        if (ION_NAMES.has(res))   return false;                          // no ions
        return true;
    });
}

/**
 * Format atom name into PDB 4-char field (columns 13-16).
 * PDB convention: 1-char elements start at col 14; 2-char at col 13.
 */
function fmtAtomName(rawName, element) {
    const name = rawName.trim();
    const el   = (element || '').trim();
    if (name.length >= 4) return name.slice(0,4);
    if (el.length >= 2 || name.length === 4) return name.padEnd(4).slice(0,4);
    return (' ' + name).padEnd(4).slice(0,4);
}

/**
 * Render one atom as a PDB ATOM record (80-char line).
 */
function toPdbRecord(a, serial) {
    const group   = 'ATOM  ';
    const ser     = String(serial % 100000).padStart(5);
    const aName   = fmtAtomName(a['auth_atom_id'] || a['label_atom_id'] || 'X', a['type_symbol']);
    const altLoc  = (a['label_alt_id'] === '.' || !a['label_alt_id'] ? ' ' : a['label_alt_id'])[0];
    const resName = (a['auth_comp_id']  || a['label_comp_id']  || 'UNK').padEnd(3).slice(0,3);
    const chainId = (a['auth_asym_id']  || a['label_asym_id']  || 'A')[0];
    const resSeq  = String(a['auth_seq_id'] || a['label_seq_id'] || 0).padStart(4).slice(-4);
    const iCode   = (a['pdbx_PDB_ins_code'] === '?' || !a['pdbx_PDB_ins_code'] ? ' ' : a['pdbx_PDB_ins_code'])[0];
    const x       = parseFloat(a['Cartn_x'] || 0).toFixed(3).padStart(8);
    const y       = parseFloat(a['Cartn_y'] || 0).toFixed(3).padStart(8);
    const z       = parseFloat(a['Cartn_z'] || 0).toFixed(3).padStart(8);
    const occ     = parseFloat(a['occupancy']        || 1).toFixed(2).padStart(6);
    const bfac    = parseFloat(a['B_iso_or_equiv']   || 0).toFixed(2).padStart(6);
    const elem    = ((a['type_symbol'] || '')).padStart(2).slice(0,2);

    // Standard PDB ATOM line (columns 1-80)
    return `${group}${ser} ${aName}${altLoc}${resName} ${chainId}${resSeq}${iCode}   ${x}${y}${z}${occ}${bfac}          ${elem}  `;
}

/**
 * Main export: given mmCIF text, return PDB-format string.
 * Returns null if no valid atoms found.
 */
function cifToPdb(cifText, pdbId) {
    const allAtoms     = parseCifAtomSite(cifText);
    const chainAAtoms  = filterAtoms(allAtoms);

    if (chainAAtoms.length === 0) return null;

    const lines = [
        `REMARK   1 GENERATED FROM RCSB PDB ENTRY ${pdbId}`,
        `REMARK   2 CHAIN A ONLY – NO WATER, IONS, OR LIGANDS`,
    ];

    chainAAtoms.forEach((a, idx) => {
        lines.push(toPdbRecord(a, idx + 1));
    });

    lines.push('END');
    return lines.join('\n') + '\n';
}

module.exports = { cifToPdb };