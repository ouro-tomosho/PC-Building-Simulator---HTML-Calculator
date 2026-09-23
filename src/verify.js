'use strict';
/*
 * Independent solution verifier.
 *
 * Intentionally does NOT import lib/spec.js: it re-derives every constraint from
 * the raw part records with its own code, so a bug in the solver's index tables
 * cannot hide behind a shared predicate.
 */

const S = require('./score');
const { ramSpeedKey, socketSpeedTable } = require('./catalog');

function verifySolution(catalog, pools, params, sol) {
    const errors = [];
    const cpu = pools.cpus[sol.cpu];
    const mobo = pools.mobos[sol.mobo];
    const ram = pools.rams[sol.ram];
    const gpu = pools.gpus[sol.gpu];
    const pcCase = pools.pcCases[sol.pcCase];

    if (!cpu) errors.push('cpu not in pool: ' + sol.cpu);
    if (!mobo) errors.push('mobo not in pool: ' + sol.mobo);
    if (!ram) errors.push('ram not in pool: ' + sol.ram);
    if (!gpu) errors.push('gpu not in pool: ' + sol.gpu);
    if (!pcCase) errors.push('case not in pool: ' + sol.pcCase);
    if (errors.length) return errors;

    // --- socket ---------------------------------------------------------
    const a = mobo.cpuSocket, b = cpu.cpuSocket;
    const socketOk = a === b ||
        (a === 'LGA 1151 (Skylake)' && b === 'LGA 1151 (Kaby Lake)') ||
        (a === 'LGA 1151 (Kaby Lake)' && b === 'LGA 1151 (Skylake)') ||
        (a === 'SP3r1' && b === 'SP3r2') || (a === 'SP3r2' && b === 'SP3r1');
    if (!socketOk) errors.push('cpu/mobo socket mismatch');

    // --- ram ------------------------------------------------------------
    if (mobo.ramType !== ram.ramType) errors.push('ram type mismatch');
    if (mobo.ramSlots < sol.ramChannel) errors.push('too many RAM sticks for motherboard');
    if (ram.frequency !== sol.ramSpeed) errors.push('ram frequency != chosen speed');
    if (!mobo.memorySpeedSteps.map(Number).includes(sol.ramSpeed)) errors.push('motherboard does not list that RAM speed');
    if (sol.ramChannel > cpu.maxMemoryChannels) errors.push('too many RAM channels for CPU');
    if (sol.ramChannel < 1) errors.push('ramChannel < 1');
    const speeds = socketSpeedTable(catalog)[ramSpeedKey(cpu.cpuSocket)];
    if (speeds && speeds.length && !speeds.includes(sol.ramSpeed)) errors.push('speed not in socket speed table');
    if (params.minSysRamGB != null && sol.ramChannel * ram.totalSizeGB < params.minSysRamGB) {
        errors.push('system RAM below minimum');
    }
    if (params.minRamFrequency != null && ram.frequency < params.minRamFrequency) errors.push('ram below minimum frequency');

    // --- gpu / case ------------------------------------------------------
    if (sol.gpuCount !== 1 && sol.gpuCount !== 2) errors.push('bad gpuCount');
    if (sol.gpuCount === 2) {
        if (gpu.multiGPU == null) errors.push('gpu does not support multi-GPU');
        if (mobo.dualGpuMaxSlotSize == null || mobo.dualGpuMaxSlotSize < gpu.realSlotSize) {
            errors.push('motherboard cannot host that dual-GPU slot size');
        }
        if (gpu.multiGPU === 'SLI' && mobo.supportSLI !== 'Yes') errors.push('motherboard lacks SLI');
        if (gpu.multiGPU === 'CrossFire' && mobo.supportCrossfire !== 'Yes') errors.push('motherboard lacks CrossFire');
    }
    if (!pcCase.motherboardSize.includes(mobo.motherboardSize)) errors.push('case does not accept motherboard form factor');
    if (pcCase.maxGpuLength < gpu.length) errors.push('gpu too long for case');
    if (sol.gpuCount === 2 && gpu.realSlotSize > 2 && !pcCase.motherboardSize.includes('S-ATX')) {
        errors.push('case cannot host a wide dual-GPU setup');
    }
    if (params.gpuType && params.gpuType !== 'Any' && gpu.gpuType !== params.gpuType) errors.push('gpu type filtered out');
    // 输入归一化（不是兼容性谓词）：<select> 交出来的是字符串 '2'，'2' !== 2 会误判。
    const wantedGpuCount = params.gpuCount == null || params.gpuCount === 'Any' || params.gpuCount === ''
        ? null : Number(params.gpuCount);
    if (wantedGpuCount != null && Number.isFinite(wantedGpuCount) && wantedGpuCount > 0 &&
        wantedGpuCount !== sol.gpuCount) {
        errors.push('gpu count filtered out');
    }
    if (params.minVramGB != null && gpu.vramGB < params.minVramGB) errors.push('vram below minimum');

    // --- cost / score ----------------------------------------------------
    const expected = cpu.price + mobo.price + sol.ramChannel * ram.price +
        sol.gpuCount * gpu.price + pcCase.price;
    if (expected !== sol.price) errors.push('price mismatch: recorded ' + sol.price + ' actual ' + expected);
    const budgetEff = Math.min(Number(params.budget) || 0, (Number(params.budget) || 0) - (Number(params.reserved) || 0));
    if (expected > budgetEff) errors.push('over budget: ' + expected + ' > ' + budgetEff);

    const C = S.cpuScore(cpu, sol.ramChannel, sol.ramSpeed);
    const G = S.gpuScore(gpu, sol.gpuCount);
    if (C !== sol.cpuScoreValue) errors.push('cpu score mismatch');
    if (G !== sol.gpuScoreValue) errors.push('gpu score mismatch');
    if (!S.scoreFeasible(C, G, params.targetScore || 0)) {
        errors.push('target score not met: S=' + S.systemScore(C, G) + ' < T=' + (params.targetScore || 0));
    }
    if (sol.score !== S.systemScore(C, G)) errors.push('system score mismatch');

    return errors;
}

function verifyAll(catalog, pools, params, result) {
    const problems = [];
    for (const sol of result.solutions) {
        const errors = verifySolution(catalog, pools, params, sol);
        if (errors.length) problems.push({ sol, errors });
        if (sol.price !== result.price) problems.push({ sol, errors: ['price != optimum'] });
    }
    return problems;
}

module.exports = { verifySolution, verifyAll };
