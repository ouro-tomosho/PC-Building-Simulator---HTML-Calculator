'use strict';
/*
 * Shared result-shaping helpers.  Both the brute-force reference and the fast
 * solver funnel their raw solution records through `finalizeSolutions`, so their
 * outputs are directly comparable field by field.
 */

/** Canonical identity of an assembly (every decision variable except derived values). */
function signature(sol) {
    return [
        sol.cpu, sol.mobo, sol.ram, sol.ramChannel, sol.ramSpeed,
        sol.gpu, sol.gpuCount, sol.pcCase,
    ].join('|');
}

function compareSolutions(a, b) {
    if (a.price !== b.price) return a.price - b.price;
    if (a.score !== b.score) return b.score - a.score;
    if (a.watts !== b.watts) return a.watts - b.watts;
    const ca = a.cpu + '|' + a.gpu + '|' + a.mobo + '|' + a.pcCase + '|' + a.ram;
    const cb = b.cpu + '|' + b.gpu + '|' + b.mobo + '|' + b.pcCase + '|' + b.ram;
    return ca.localeCompare(cb);
}

/**
 * Deduplicate by assembly signature, sort deterministically, then cap.
 * `resultsRequested` may be Infinity to keep the whole optimum set.
 */
function finalizeSolutions(raw, price, resultsRequested) {
    const seen = new Map();
    for (const sol of raw) {
        const key = signature(sol);
        if (!seen.has(key)) seen.set(key, sol);
    }
    let out = Array.from(seen.values()).sort(compareSolutions);
    if (Number.isFinite(resultsRequested) && out.length > resultsRequested) {
        out = out.slice(0, resultsRequested);
    }
    return { price, solutions: out };
}

/** Set equality on canonical signatures. */
function sameSolutionSet(a, b) {
    const A = new Set(a.map(signature));
    const B = new Set(b.map(signature));
    if (A.size !== B.size) return false;
    for (const key of A) if (!B.has(key)) return false;
    return true;
}

function describeSolution(sol) {
    return signature(sol) + ' @' + sol.price + ' score=' + sol.score;
}

module.exports = {
    signature,
    compareSolutions,
    finalizeSolutions,
    sameSolutionSet,
    describeSolution,
};
