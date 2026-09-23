'use strict';
/*
 * The specification: literal compatibility predicates, the user-filter layer, and
 * the derived quantities (effective budget, RAM stick requirement).
 *
 * These predicates are deliberately a *plain transcription* of the tool's
 * "Part Compatibility Checks" script.  The fast solver never calls them in its hot
 * path (it uses precomputed index tables); the brute-force reference and the
 * independent verifier do.  Keeping one authoritative transcription here means the
 * differential test exercises the *search*, which is where the risk lives.
 */

/** script cpuSupportsGpu: trivial for the non-HEM catalog used here. */
function cpuSupportsGpu(/* cpu, gpu */) {
    return true;
}

/** script moboSupportsCpu */
function moboSupportsCpu(mobo, cpu) {
    const a = mobo.cpuSocket;
    const b = cpu.cpuSocket;
    return (
        (a === 'LGA 1151 (Skylake)' && b === 'LGA 1151 (Kaby Lake)') ||
        (b === 'LGA 1151 (Skylake)' && a === 'LGA 1151 (Kaby Lake)') ||
        (a === 'SP3r1' && b === 'SP3r2') ||
        (b === 'SP3r1' && a === 'SP3r2') ||
        (a === 'SP3r1 (2P)' && b === 'SP3r2 (2P)') ||
        (b === 'SP3r1 (2P)' && a === 'SP3r2 (2P)') ||
        (a === b)
    );
}

/** script moboSupportsGpu */
function moboSupportsGpu(mobo, gpu, gpuCount) {
    if (gpuCount === 1) return true;
    if (gpuCount !== 2) return false;
    if (mobo.dualGpuMaxSlotSize == null || mobo.dualGpuMaxSlotSize < gpu.realSlotSize) return false;
    if (gpu.multiGPU === 'SLI') return mobo.supportSLI === 'Yes';
    if (gpu.multiGPU === 'CrossFire') return mobo.supportCrossfire === 'Yes';
    return false;
}

/** script moboSupportsRamType */
function moboSupportsRamType(mobo, ram) {
    return mobo.ramType === ram.ramType;
}

/** script moboSupportsRamCount */
function moboSupportsRamCount(mobo, ramChannel) {
    return mobo.ramSlots >= ramChannel;
}

/** script caseSupportsMobo (substring test on the comma-joined size list) */
function caseSupportsMobo(pcCase, mobo) {
    return pcCase.motherboardSize.includes(mobo.motherboardSize);
}

/** script caseSupportsGpu */
function caseSupportsGpu(pcCase, gpu, gpuCount) {
    return (
        pcCase.maxGpuLength >= gpu.length &&
        (gpuCount === 1 ||
            gpu.realSlotSize <= 2 ||
            pcCase.motherboardSize.includes('S-ATX'))
    );
}

/** Memory frequency support (the tool uses memorySpeedSteps.includes(String(s))). */
function moboSupportsSpeed(mobo, ramSpeed) {
    const steps = mobo.memorySpeedSteps;
    for (let i = 0; i < steps.length; i++) {
        if (Number(steps[i]) === ramSpeed) return true;
    }
    return false;
}

function brandNarrow(parts, brand) {
    if (!brand || brand === 'Any') return parts;
    const out = {};
    let n = 0;
    for (const name in parts) {
        if (parts[name].manufacturer === brand) { out[name] = parts[name]; n++; }
    }
    return n > 0 ? out : parts; // per-dimension soft preference with fallback
}

/**
 * Own-property lookup.  `parts[name]` alone would treat '__proto__' / 'constructor'
 * as a hit (they resolve on the prototype chain), silently emptying the pool or
 * letting a non-part object into the solver; an unknown model name must simply be
 * ignored, exactly like any other typo.
 */
function ownPart(parts, name) {
    if (!name || !Object.prototype.hasOwnProperty.call(parts, name)) return null;
    return parts[name];
}

function filterByRankAndLimit(parts, params, kind) {
    const limit = kind === 'cpu' ? params.limitCpu : params.limitGpu;
    const minName = kind === 'cpu' ? params.minCpuName : params.minGpuName;
    const pinned = ownPart(parts, minName);
    if (limit && pinned) {
        const one = {};
        one[minName] = pinned;
        return one;
    }
    if (!pinned) return parts;
    const floor = pinned.partRankingScore;
    const out = {};
    for (const name in parts) {
        if (parts[name].partRankingScore >= floor) out[name] = parts[name];
    }
    return Object.keys(out).length ? out : {};
}

/**
 * The Build Maker filter layer (script getBuildMakerFilterValues /
 * buildDataForBuildMaker), producing the exact pools the solver searches.
 * `params.minSysRamGB` is deliberately NOT applied here: it is a per-skeleton
 * constraint (ramChannel * stickSize >= min), not a pool filter.
 */
function narrowPools(base, params) {
    const brand = params.brand || 'Any';

    let cpus = filterByRankAndLimit(brandNarrow(base.cpus, brand), params, 'cpu');
    let gpus = filterByRankAndLimit(brandNarrow(base.gpus, brand), params, 'gpu');
    let mobos = brandNarrow(base.mobos, brand);
    let rams = brandNarrow(base.rams, brand);
    let pcCases = brandNarrow(base.pcCases, brand);

    if (params.cpuSocket && params.cpuSocket !== 'Any') {
        const out = {};
        for (const name in cpus) if (cpus[name].cpuSocket === params.cpuSocket) out[name] = cpus[name];
        cpus = out;
    }
    if (params.needCpuOverclock) {
        const oc = {};
        for (const name in cpus) if (cpus[name].canOverclock === 'Yes') oc[name] = cpus[name];
        cpus = oc;
        const om = {};
        for (const name in mobos) if (mobos[name].canOverclock === 'Yes') om[name] = mobos[name];
        mobos = om;
    }
    if (params.gpuType && params.gpuType !== 'Any') {
        const out = {};
        for (const name in gpus) if (gpus[name].gpuType === params.gpuType) out[name] = gpus[name];
        gpus = out;
    }
    if (params.minVramGB != null) {
        const out = {};
        for (const name in gpus) if (gpus[name].vramGB >= params.minVramGB) out[name] = gpus[name];
        gpus = out;
    }
    if (ownPart(mobos, params.moboName)) {
        const one = {};
        one[params.moboName] = mobos[params.moboName];
        mobos = one;
    }
    if (ownPart(pcCases, params.caseName)) {
        const one = {};
        one[params.caseName] = pcCases[params.caseName];
        pcCases = one;
    }
    if (params.minRamFrequency != null) {
        const out = {};
        for (const name in rams) if (rams[name].frequency >= params.minRamFrequency) out[name] = rams[name];
        rams = out;
    }
    return { cpus, gpus, mobos, rams, pcCases };
}

/** The tool checks the total against *both* B and B - reserved. */
function effectiveBudget(params) {
    const budget = Number(params.budget) || 0;
    const reserved = Number(params.reserved) || 0;
    return Math.min(budget, budget - reserved);
}

function ramStickRequirement(params, ramChannel) {
    if (params.minSysRamGB == null) return 0;
    return Math.ceil(params.minSysRamGB / ramChannel);
}

/**
 * GPU-count filter, normalised to a number (null = no filter).
 *
 * A `<select>` hands its value over as a **string**, so `params.gpuCount === 2` is
 * false for the UI's "双卡" and the solver silently finds nothing.  Every solver
 * goes through this helper so that "双卡" means 2 no matter how it was typed.
 */
function gpuCountFilter(params) {
    const raw = params.gpuCount;
    if (raw == null || raw === 'Any' || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
}

module.exports = {
    cpuSupportsGpu,
    moboSupportsCpu,
    moboSupportsGpu,
    moboSupportsRamType,
    moboSupportsRamCount,
    caseSupportsMobo,
    caseSupportsGpu,
    moboSupportsSpeed,
    brandNarrow,
    narrowPools,
    effectiveBudget,
    ramStickRequirement,
    gpuCountFilter,
    ownPart,
};
