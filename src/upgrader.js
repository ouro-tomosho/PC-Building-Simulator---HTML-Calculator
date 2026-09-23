'use strict';
/*
 * Build Upgrader: the same standard problem restricted to a partially fixed
 * machine.
 *
 *   original : (cpu0, mobo0, gpu0, n0, ramSticks0, ramRatedSpeed0, case0)
 *   free     : a subset of {cpu, mobo, gpu}   (RAM and case are never replaced)
 *   cost     : the *marginal* price of the parts that actually change
 *   target   : mandatory lower bound on the score
 *
 * Derived quantities:
 *   q(c)  = min(ramSticks0, channels(c))            sticks that remain usable
 *   s(m)  = XMP(ramRatedSpeed0, m)                  largest supported step <= rated
 *
 * Two safety guards that the current tool omits are applied here (they are latent
 * there: on the shipped dataset no socket mixes motherboard RAM types and every
 * motherboard has at least as many slots as its CPUs have channels):
 *
 *   ramType(m) == ramType(ram0)      otherwise the existing sticks do not fit
 *   slots(m)   >= q(c)               otherwise the existing sticks do not fit
 *
 * Two search strategies are provided -- a support-driven brute force (ground truth)
 * and an explicit subset enumeration -- so the differential test exercises the
 * search structure rather than a shared code path.
 */

const S = require('./score');
const spec = require('./spec');
const { finalizeSolutions } = require('./util');

const TOOL_PATHS = [
    ['cpu'], ['gpu'], ['cpu', 'gpu'], ['cpu', 'mobo'], ['gpu', 'mobo'], ['cpu', 'gpu', 'mobo'],
];
const IDEAL_PATHS = TOOL_PATHS.concat([['mobo']]);

function pathFamily(name) {
    return name === 'tool6' ? TOOL_PATHS : IDEAL_PATHS;
}

/**
 * The original machine is *owned*: it is always a legal choice even when the user's
 * brand / overclock filters removed it from the replacement pool (the tool behaves
 * the same way -- it validates the original system against the unfiltered data).
 */
function partLookup(catalog, pools, original) {
    const out = {};
    for (const dim of ['cpus', 'gpus', 'mobos', 'rams', 'pcCases', 'storages']) {
        out[dim] = Object.assign({}, pools[dim]);
    }
    // Own-property lookup: '__proto__' 之类的输入不能命中原型链上的东西。
    const ensure = (dim, name) => {
        if (name && !spec.ownPart(out[dim], name) && spec.ownPart(catalog[dim], name)) {
            out[dim][name] = spec.ownPart(catalog[dim], name);
        }
    };
    ensure('cpus', original.cpu);
    ensure('mobos', original.mobo);
    ensure('gpus', original.gpu);
    ensure('pcCases', original.case);
    return out;
}

/** Pool keys plus the original part name (so "keep it" is always a candidate). */
function candidateNames(pools, dim, originalName) {
    const names = Object.keys(pools[dim]);
    if (originalName && names.indexOf(originalName) < 0) names.push(originalName);
    return names;
}

/** The tool's getRamSpeedXMP: largest supported step not above the rated speed. */
function xmpSpeed(mobo, ratedSpeed) {
    const steps = mobo.memorySpeedSteps.map(Number).sort((a, b) => a - b);
    let chosen = null;
    for (const step of steps) {
        if (chosen === null || step <= ratedSpeed) chosen = step;
        else break;
    }
    return chosen;
}

function effectiveRamChannel(cpu, original) {
    return Math.min(original.ramSticks, cpu.maxMemoryChannels);
}

function effectiveGpuCount(assigned, original) {
    return assigned.gpuCount == null ? original.gpuCount : assigned.gpuCount;
}

/**
 * Marginal price of the parts that actually change.
 * Owning n0 identical cards and ending up with n <= n0 of the same model costs
 * nothing; ending up with more costs (n - n0) cards; any other model costs n cards.
 */
function marginalCost(assigned, original, pools) {
    let cost = 0;
    if (assigned.cpu !== original.cpu) cost += pools.cpus[assigned.cpu].price;
    if (assigned.mobo !== original.mobo) cost += pools.mobos[assigned.mobo].price;
    const gpuCount = effectiveGpuCount(assigned, original);
    if (assigned.gpu === original.gpu) {
        if (gpuCount > original.gpuCount) {
            cost += (gpuCount - original.gpuCount) * pools.gpus[original.gpu].price;
        }
    } else {
        cost += gpuCount * pools.gpus[assigned.gpu].price;
    }
    return cost;
}

function effectiveSupport(assigned, original) {
    const support = [];
    if (assigned.cpu !== original.cpu) support.push('cpu');
    if (assigned.mobo !== original.mobo) support.push('mobo');
    if (assigned.gpu !== original.gpu ||
        effectiveGpuCount(assigned, original) !== original.gpuCount) support.push('gpu');
    return support;
}

/**
 * Feasibility of one (possibly partially) assigned machine.  Returns a problem
 * string, or null when the assignment is legal.
 */
function assignmentProblem(assigned, original, params, pools) {
    const cpu = pools.cpus[assigned.cpu];
    const mobo = pools.mobos[assigned.mobo];
    const gpu = pools.gpus[assigned.gpu];
    if (!cpu) return 'cpu not in pool';
    if (!mobo) return 'mobo not in pool';
    if (!gpu) return 'gpu not in pool';

    const gpuCount = effectiveGpuCount(assigned, original);
    if (gpuCount !== 1 && gpuCount !== 2) return 'bad gpu count';
    if (gpuCount === 2 && gpu.multiGPU == null) return 'gpu cannot run dual';

    if (!spec.moboSupportsCpu(mobo, cpu)) return 'cpu/mobo socket mismatch';
    if (!spec.cpuSupportsGpu(cpu, gpu)) return 'cpu does not support gpu';
    if (!spec.moboSupportsGpu(mobo, gpu, gpuCount)) return 'mobo cannot host the gpu setup';

    // the two guards the tool omits
    if (mobo.ramType !== original.ramType) return 'motherboard RAM type does not match the existing sticks';
    const ramChannel = effectiveRamChannel(cpu, original);
    if (!spec.moboSupportsRamCount(mobo, ramChannel)) return 'motherboard has too few RAM slots for the existing sticks';

    if (original.case) {
        const pcCase = pools.pcCases[original.case];
        if (!pcCase) return 'original case not in pool';
        if (!spec.caseSupportsMobo(pcCase, mobo)) return 'case does not accept the motherboard';
        if (!spec.caseSupportsGpu(pcCase, gpu, gpuCount)) return 'case does not accept the gpu setup';
    }

    const ramSpeed = xmpSpeed(mobo, original.ramSpeed);
    const C = S.cpuScore(cpu, ramChannel, ramSpeed);
    const G = S.gpuScore(gpu, gpuCount);
    if (!S.scoreFeasible(C, G, params.targetScore || 0)) return 'target score not met';
    return null;
}

function makeSolution(assigned, original, params, pools) {
    const cpu = pools.cpus[assigned.cpu];
    const mobo = pools.mobos[assigned.mobo];
    const gpu = pools.gpus[assigned.gpu];
    const gpuCount = effectiveGpuCount(assigned, original);
    const ramChannel = effectiveRamChannel(cpu, original);
    const ramSpeed = xmpSpeed(mobo, original.ramSpeed);
    const C = S.cpuScore(cpu, ramChannel, ramSpeed);
    const G = S.gpuScore(gpu, gpuCount);
    return {
        cpu: assigned.cpu, mobo: assigned.mobo, gpu: assigned.gpu, gpuCount,
        ramChannel, ramSpeed,
        price: marginalCost(assigned, original, pools),
        cpuScoreValue: C, gpuScoreValue: G,
        score: S.systemScore(C, G),
        watts: S.systemWatts(cpu, gpu, gpuCount),
    };
}

/**
 * Ground truth: enumerate every combination of (cpu, mobo, gpu, gpuCount) drawn
 * from {original} ∪ pool and keep those whose *effective* support is a non-empty
 * subset of the allowed path family.  No subset structure is imposed by the search.
 */
function solveBuildUpgraderBrute(catalog, pools, original, params, options) {
    options = options || {};
    const allowed = new Set(pathFamily(options.paths).map((p) => p.slice().sort().join(',')));
    const budgetEff = spec.effectiveBudget(params);
    const gpuCountFilter = spec.gpuCountFilter(params);
    const lookup = partLookup(catalog, pools, original);
    const cpuChoices = candidateNames(pools, 'cpus', original.cpu);
    const moboChoices = candidateNames(pools, 'mobos', original.mobo);
    const gpuChoices = candidateNames(pools, 'gpus', original.gpu);

    let best = Infinity;
    const raw = [];
    for (const cpu of cpuChoices) {
        for (const mobo of moboChoices) {
            for (const gpu of gpuChoices) {
                for (const gpuCount of [1, 2]) {
                    if (gpuCountFilter != null && gpuCountFilter !== gpuCount) continue;
                    const assigned = { cpu, mobo, gpu, gpuCount };
                    const support = effectiveSupport(assigned, original);
                    if (!support.length) continue;
                    if (!allowed.has(support.slice().sort().join(','))) continue;
                    if (assignmentProblem(assigned, original, params, lookup)) continue;
                    const sol = makeSolution(assigned, original, params, lookup);
                    if (sol.price > budgetEff) continue;
                    if (sol.price > best) continue;
                    if (sol.price < best) { best = sol.price; raw.length = 0; }
                    raw.push(sol);
                }
            }
        }
    }
    if (!Number.isFinite(best)) return { price: Infinity, solutions: [] };
    return finalizeSolutions(raw, best, params.resultsRequested == null ? 15 : params.resultsRequested);
}

/** Support mask bits: 1 = cpu, 2 = mobo, 4 = gpu setup. */
function maskOfPath(path) {
    let mask = 0;
    for (const slot of path) {
        if (slot === 'cpu') mask |= 1;
        else if (slot === 'mobo') mask |= 2;
        else if (slot === 'gpu') mask |= 4;
    }
    return mask;
}

/** What a completely owned card setup costs: extra cards only, never the owned ones. */
function gpuMarginalCost(gpuName, gpuCount, original, pools) {
    if (gpuName === original.gpu) {
        if (gpuCount <= original.gpuCount) return 0;
        return (gpuCount - original.gpuCount) * pools.gpus[original.gpu].price;
    }
    return gpuCount * pools.gpus[gpuName].price;
}

/**
 * Exact Upgrader search, ordered by marginal price so the running optimum prunes
 * almost the whole product.  Candidate lists are sorted by *marginal* cost and each
 * loop breaks as soon as the partial sum exceeds the best price found so far
 * (partial sums are non-decreasing along the loops, so the break is safe).
 */
function solveBuildUpgrader(catalog, pools, original, params, options) {
    options = options || {};
    const allowed = new Set(pathFamily(options.paths).map(maskOfPath));
    const budgetEff = spec.effectiveBudget(params);
    const T = params.targetScore || 0;
    const gpuCountFilter = spec.gpuCountFilter(params);
    const limit = params.resultsRequested == null ? 15 : params.resultsRequested;

    const lookup = partLookup(catalog, pools, original);

    const moboCands = [];
    for (const name of candidateNames(pools, 'mobos', original.mobo)) {
        moboCands.push({ name, cost: name === original.mobo ? 0 : lookup.mobos[name].price, changed: name !== original.mobo });
    }
    moboCands.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));

    const cpuCands = [];
    for (const name of candidateNames(pools, 'cpus', original.cpu)) {
        cpuCands.push({ name, cost: name === original.cpu ? 0 : lookup.cpus[name].price, changed: name !== original.cpu });
    }
    cpuCands.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));

    const gpuCands = [];
    for (const name of candidateNames(pools, 'gpus', original.gpu)) {
        const gpu = lookup.gpus[name];
        for (const n of [1, 2]) {
            if (gpuCountFilter != null && gpuCountFilter !== n) continue;
            if (n === 2 && gpu.multiGPU == null) continue;
            gpuCands.push({ name, n, cost: gpuMarginalCost(name, n, original, lookup), changed: name !== original.gpu || n !== original.gpuCount });
        }
    }
    gpuCands.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name) || a.n - b.n);

    const gpuOk = new Map();
    const compatFor = (moboName) => {
        let bits = gpuOk.get(moboName);
        if (bits) return bits;
        const mobo = lookup.mobos[moboName];
        bits = new Uint8Array(gpuCands.length);
        for (let i = 0; i < gpuCands.length; i++) {
            const cand = gpuCands[i];
            const gpu = lookup.gpus[cand.name];
            if (!spec.moboSupportsGpu(mobo, gpu, cand.n)) continue;
            if (original.case && !spec.caseSupportsGpu(lookup.pcCases[original.case], gpu, cand.n)) continue;
            bits[i] = 1;
        }
        gpuOk.set(moboName, bits);
        return bits;
    };

    let best = Infinity;
    let raw = [];
    let truncated = false;
    let expansions = 0;
    const maxExpansions = options.maxExpansions || 4000000;

    outer:
    for (const mCand of moboCands) {
        if (mCand.cost > best) break;
        const mobo = lookup.mobos[mCand.name];
        if (mobo.ramType !== original.ramType) continue;                       // guard: existing sticks fit
        if (original.case && !spec.caseSupportsMobo(lookup.pcCases[original.case], mobo)) continue;
        const compat = compatFor(mCand.name);

        for (const cCand of cpuCands) {
            if (mCand.cost + cCand.cost > best) break;
            const cpu = lookup.cpus[cCand.name];
            if (!spec.moboSupportsCpu(mobo, cpu)) continue;
            const ramChannel = effectiveRamChannel(cpu, original);
            if (mobo.ramSlots < ramChannel) continue;                          // guard: existing sticks fit
            const ramSpeed = xmpSpeed(mobo, original.ramSpeed);
            const C = S.cpuScore(cpu, ramChannel, ramSpeed);
            if (T > 0 && 20 * C <= 3 * T) continue;                            // CPU score floor

            for (let gi = 0; gi < gpuCands.length; gi++) {
                const gCand = gpuCands[gi];
                if (mCand.cost + cCand.cost + gCand.cost > best) break;
                if (!compat[gi]) continue;
                if (++expansions > maxExpansions) { truncated = true; break outer; }
                const gpu = lookup.gpus[gCand.name];
                if (!spec.cpuSupportsGpu(cpu, gpu)) continue;
                const G = S.gpuScore(gpu, gCand.n);
                if (!S.scoreFeasible(C, G, T)) continue;

                const price = mCand.cost + cCand.cost + gCand.cost;
                if (price > budgetEff) continue;
                const mask = (cCand.changed ? 1 : 0) | (mCand.changed ? 2 : 0) | (gCand.changed ? 4 : 0);
                if (!mask || !allowed.has(mask)) continue;

                if (price < best) { best = price; raw = []; }
                raw.push({
                    cpu: cCand.name, mobo: mCand.name, gpu: gCand.name, gpuCount: gCand.n,
                    ramChannel, ramSpeed, price,
                    cpuScoreValue: C, gpuScoreValue: G,
                    score: S.systemScore(C, G),
                    watts: S.systemWatts(cpu, gpu, gCand.n),
                });
            }
        }
    }

    if (!Number.isFinite(best)) return { price: Infinity, solutions: [], truncated };
    const result = finalizeSolutions(raw, best, limit);
    result.truncated = truncated;
    return result;
}

module.exports = {
    xmpSpeed,
    marginalCost,
    effectiveSupport,
    assignmentProblem,
    solveBuildUpgrader,
    solveBuildUpgraderBrute,
    TOOL_PATHS,
    IDEAL_PATHS,
};
