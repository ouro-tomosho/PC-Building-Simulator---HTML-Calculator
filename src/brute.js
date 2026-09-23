'use strict';
/*
 * Brute-force reference solver.
 *
 * Deliberately naive: the full Cartesian product over (cpu, ramChannel, ramSpeed,
 * gpu, gpuCount, mobo, ram, case) with a literal compatibility check at the leaf.
 * No decomposition, no pruning, no index tables -- it is the ground truth the fast
 * solver is differential-tested against.
 *
 * Only usable on small catalogs; that is the point.
 */

const S = require('./score');
const spec = require('./spec');
const { usableSpeeds } = require('./catalog');
const { finalizeSolutions } = require('./util');

function values(obj) {
    const out = [];
    for (const name in obj) out.push(name);
    return out;
}

function bruteSolveBuildMaker(catalog, pools, params) {
    const budgetEff = spec.effectiveBudget(params);
    const T = params.targetScore || 0;
    const gpuCountFilter = spec.gpuCountFilter(params);
    const resultsRequested = params.resultsRequested == null ? 15 : params.resultsRequested;

    const cpuNames = values(pools.cpus);
    const gpuNames = values(pools.gpus);
    const moboNames = values(pools.mobos);
    const ramNames = values(pools.rams);
    const caseNames = values(pools.pcCases);

    let best = Infinity;
    const raw = [];

    for (const cpuName of cpuNames) {
        const cpu = pools.cpus[cpuName];
        const speeds = usableSpeeds(catalog, cpu.cpuSocket, pools.rams);
        for (let ramChannel = 1; ramChannel <= cpu.maxMemoryChannels; ramChannel++) {
            const requiredStickGB = spec.ramStickRequirement(params, ramChannel);
            for (const ramSpeed of speeds) {
                const C = S.cpuScore(cpu, ramChannel, ramSpeed);
                for (const gpuName of gpuNames) {
                    const gpu = pools.gpus[gpuName];
                    if (!spec.cpuSupportsGpu(cpu, gpu)) continue;
                    for (const gpuCount of [1, 2]) {
                        if (gpuCountFilter != null && gpuCountFilter !== gpuCount) continue;
                        if (gpuCount === 2 && (gpu.multiGPU == null)) continue;
                        const G = S.gpuScore(gpu, gpuCount);
                        if (!S.scoreFeasible(C, G, T)) continue;
                        for (const moboName of moboNames) {
                            const mobo = pools.mobos[moboName];
                            if (!spec.moboSupportsCpu(mobo, cpu)) continue;
                            if (!spec.moboSupportsGpu(mobo, gpu, gpuCount)) continue;
                            if (!spec.moboSupportsRamCount(mobo, ramChannel)) continue;
                            if (!spec.moboSupportsSpeed(mobo, ramSpeed)) continue;
                            for (const ramName of ramNames) {
                                const ram = pools.rams[ramName];
                                if (ram.frequency !== ramSpeed) continue;
                                if (!spec.moboSupportsRamType(mobo, ram)) continue;
                                if (ram.totalSizeGB < requiredStickGB) continue;
                                for (const caseName of caseNames) {
                                    const pcCase = pools.pcCases[caseName];
                                    if (!spec.caseSupportsMobo(pcCase, mobo)) continue;
                                    if (!spec.caseSupportsGpu(pcCase, gpu, gpuCount)) continue;
                                    const price = cpu.price + mobo.price + ramChannel * ram.price +
                                        gpuCount * gpu.price + pcCase.price;
                                    if (price > budgetEff) continue;
                                    const sol = {
                                        cpu: cpuName, mobo: moboName, ram: ramName, pcCase: caseName,
                                        gpu: gpuName, vram: gpu.vramGB, gpuCount, ramChannel, ramSpeed,
                                        price,
                                        cpuScoreValue: C, gpuScoreValue: G,
                                        score: S.systemScore(C, G),
                                        watts: S.systemWatts(cpu, gpu, gpuCount),
                                    };
                                    if (price < best) { best = price; raw.length = 0; }
                                    if (price === best) raw.push(sol);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (!Number.isFinite(best)) return { price: Infinity, solutions: [] };
    return finalizeSolutions(raw.filter((s) => s.price === best), best, resultsRequested);
}

module.exports = { bruteSolveBuildMaker };
