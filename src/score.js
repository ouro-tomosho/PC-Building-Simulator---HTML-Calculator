'use strict';
/*
 * Score / power model.
 *
 * Transcribed from the tool (script "Calculations - Scores" / "- Watts"), plus an
 * exact integer reformulation of the "score >= target" constraint:
 *
 *   S = floor( 1 / (0.85/G + 0.15/C) ) = floor( 20*C*G / (17*C + 3*G) )
 *
 * With T an integer,  floor(S) >= T  <=>  S >= T  <=>
 *
 *      20*C*G >= T*(17*C + 3*G)          (no floating point anywhere)
 *
 * which also yields the two complementary thresholds used by the solver:
 *
 *      G_min(C) = ceil( 17*T*C / (20*C - 3*T) )      needs C > 3T/20
 *      C_min(G) = ceil(  3*T*G / (20*G - 17*T) )     needs G > 17T/20
 */

function cpuScore(cpu, ramChannel, ramSpeed) {
    return Math.floor(
        ((cpu.coreClockMultiplier * cpu.frequency) +
         (cpu.memChannelsMultiplier * ramChannel) +
         (cpu.memClockMultiplier * ramSpeed) +
         cpu.finalAdjustment) * 298
    );
}

function gpuScore(gpu, gpuCount) {
    return (gpuCount === 1) ? gpu.singleGPUGraphicsScore : gpu.doubleGPUGraphicsScore;
}

function systemScore(cpuScoreValue, gpuScoreValue) {
    return Math.floor(
        1 / ((0.85 / gpuScoreValue) + (0.15 / cpuScoreValue))
    );
}

/** Exact feasibility test for S >= T (T integer; T <= 0 means "no constraint"). */
function scoreFeasible(C, G, T) {
    if (!T || T <= 0) return true;
    return (20 * C * G) >= T * (17 * C + 3 * G);
}

/** Smallest integer CPU score C with scoreFeasible(C, G, T); Infinity when impossible. */
function minCpuScoreForGpuScore(G, T) {
    if (!T || T <= 0) return 0;
    const den = 20 * G - 17 * T;
    if (den <= 0) return Infinity;
    return Math.ceil((3 * T * G) / den);
}

/** Smallest integer GPU score G with scoreFeasible(C, G, T); Infinity when impossible. */
function minGpuScoreForCpuScore(C, T) {
    if (!T || T <= 0) return 0;
    const den = 20 * C - 3 * T;
    if (den <= 0) return Infinity;
    return Math.ceil((17 * T * C) / den);
}

function systemWatts(cpu, gpu, gpuCount) {
    let watts = 30;
    if (cpu) watts += cpu.wattage;
    if (gpu) watts += gpuCount * gpu.wattage;
    return watts;
}

module.exports = {
    cpuScore,
    gpuScore,
    systemScore,
    scoreFeasible,
    minCpuScoreForGpuScore,
    minGpuScoreForCpuScore,
    systemWatts,
};
