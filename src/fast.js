'use strict';
/*
 * Fast exact solver for Build Maker.
 *
 * The specification implemented here is the one distilled in the analysis:
 *
 *   minimise  cost(x) = p(cpu) + p(mobo) + q*p(ram) + n*p(gpu) + p(case)
 *   over      x = (cpu, mobo, ram, q, ramSpeed, gpu, n, case)
 *   subject to  compatibility,  cost <= min(B, B - reserved),  S >= T
 *   and report *every* optimal assembly (the complete argmin level set).
 *
 * Structure exploited:
 *  1. the score constraint is the only non-local one; monotonicity turns it into
 *     a scalar threshold  C >= C_min(G)  via exact integer arithmetic;
 *  2. for a fixed context (cpuSocket, q, ramSpeed) the CPU only contributes its
 *     score and its price -> collapse it with a prefix-minimum table;
 *  3. the completion min over (mobo, case, ram) is factored: the mobo is grouped
 *     by form factor and the case/RAM optima are precomputed as monotone
 *     step-function lower envelopes (exact, unlike the greedy scan);
 *  4. GPU candidates are Pareto-reduced for the *value* search only; the optimum
 *     *set* enumeration re-scans every GPU, because a dominated-but-price-tied
 *     GPU can still belong to an optimal assembly.
 */

const S = require('./score');
const spec = require('./spec');
const { usableSpeeds } = require('./catalog');
const { finalizeSolutions } = require('./util');

/* ------------------------------------------------------------------ indexes */

function buildRamIndex(rams) {
    const buckets = new Map(); // `${type}|${freq}` -> {kits sorted by size asc, suffixMin}
    for (const name in rams) {
        const ram = rams[name];
        const key = ram.ramType + '|' + ram.frequency;
        let bucket = buckets.get(key);
        if (!bucket) { bucket = []; buckets.set(key, bucket); }
        bucket.push({ name, ram });
    }
    for (const bucket of buckets.values()) {
        bucket.sort((a, b) => a.ram.totalSizeGB - b.ram.totalSizeGB ||
            a.ram.price - b.ram.price || a.name.localeCompare(b.name));
        const suffixMin = new Array(bucket.length);
        let best = Infinity;
        for (let i = bucket.length - 1; i >= 0; i--) {
            best = Math.min(best, bucket[i].ram.price);
            suffixMin[i] = best;
        }
        bucket.suffixMin = suffixMin;
    }
    const firstIndexAtLeast = (bucket, requiredStickGB) => {
        let lo = 0, hi = bucket.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (bucket[mid].ram.totalSizeGB >= requiredStickGB) hi = mid; else lo = mid + 1;
        }
        return lo;
    };
    return {
        price(ramType, frequency, requiredStickGB) {
            const bucket = buckets.get(ramType + '|' + frequency);
            if (!bucket) return Infinity;
            const idx = firstIndexAtLeast(bucket, requiredStickGB);
            return idx < bucket.length ? bucket.suffixMin[idx] : Infinity;
        },
        argmin(ramType, frequency, requiredStickGB) {
            const bucket = buckets.get(ramType + '|' + frequency);
            if (!bucket) return [];
            const idx = firstIndexAtLeast(bucket, requiredStickGB);
            if (idx >= bucket.length) return [];
            const price = bucket.suffixMin[idx];
            const out = [];
            for (let i = idx; i < bucket.length; i++) {
                if (bucket[i].ram.price === price) out.push(bucket[i]);
            }
            return out;
        },
    };
}

/**
 * Case index keyed by (mobo form factor, needSAtx).  `best(phi, needSAtx, L)` is
 * the cheapest case that accepts form factor `phi` and a GPU of length >= L --
 * i.e. the predicate  maxGpuLength >= L, which is monotone in L.
 */
function buildCaseIndex(pcCases, lengths) {
    const cases = [];
    for (const name in pcCases) cases.push({ name, pcCase: pcCases[name] });
    const tables = new Map(); // formFactor -> [tableNoSAtx, tableSAtx]
    const lengthIndex = new Map(lengths.map((v, i) => [v, i]));

    function buildTable(formFactor, needSAtx) {
        const compat = cases.filter(({ pcCase }) =>
            pcCase.motherboardSize.includes(formFactor) &&
            (!needSAtx || pcCase.motherboardSize.includes('S-ATX')));
        compat.sort((a, b) => b.pcCase.maxGpuLength - a.pcCase.maxGpuLength ||
            a.pcCase.price - b.pcCase.price || a.name.localeCompare(b.name));
        const bestByLength = new Array(lengths.length);
        let cursor = 0;
        let running = Infinity;
        for (let i = lengths.length - 1; i >= 0; i--) {
            while (cursor < compat.length && compat[cursor].pcCase.maxGpuLength >= lengths[i]) {
                running = Math.min(running, compat[cursor].pcCase.price);
                cursor++;
            }
            bestByLength[i] = running;
        }
        return { compat, bestByLength };
    }

    function table(formFactor, needSAtx) {
        let pair = tables.get(formFactor);
        if (!pair) { pair = [null, null]; tables.set(formFactor, pair); }
        const slot = needSAtx ? 1 : 0;
        if (!pair[slot]) pair[slot] = buildTable(formFactor, needSAtx);
        return pair[slot];
    }

    return {
        lengthIndexOf(length) { return lengthIndex.get(length); },
        table,
        price(formFactor, needSAtx, length) {
            const i = lengthIndex.get(length);
            if (i === undefined) return Infinity;
            return table(formFactor, needSAtx).bestByLength[i];
        },
        argmin(formFactor, needSAtx, length) {
            const price = this.price(formFactor, needSAtx, length);
            if (!Number.isFinite(price)) return [];
            const out = [];
            for (const item of table(formFactor, needSAtx).compat) {
                if (item.pcCase.maxGpuLength >= length && item.pcCase.price === price) out.push(item);
            }
            return out;
        },
    };
}

/** Prefix-minimum CPU table over the score axis for one context (socket, q, s). */
function buildCpuTable(cpus, ramChannel, ramSpeed) {
    const rows = [];
    for (const name in cpus) {
        const cpu = cpus[name];
        if (cpu.maxMemoryChannels < ramChannel) continue;
        rows.push({ name, cpu, score: S.cpuScore(cpu, ramChannel, ramSpeed), price: cpu.price });
    }
    rows.sort((a, b) => b.score - a.score || a.price - b.price || a.name.localeCompare(b.name));
    const prefixMin = new Array(rows.length);
    let best = Infinity;
    for (let i = 0; i < rows.length; i++) {
        best = Math.min(best, rows[i].price);
        prefixMin[i] = best;
    }
    const lastIndexAtLeast = (requiredScore) => {
        let lo = 0, hi = rows.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (rows[mid].score >= requiredScore) lo = mid + 1; else hi = mid;
        }
        return lo - 1;
    };
    return {
        best(requiredScore) {
            const idx = lastIndexAtLeast(requiredScore);
            return idx < 0 ? null : { price: prefixMin[idx] };
        },
        bestWithTies(requiredScore) {
            const idx = lastIndexAtLeast(requiredScore);
            if (idx < 0) return null;
            const price = prefixMin[idx];
            const list = [];
            for (let i = 0; i <= idx; i++) if (rows[i].price === price) list.push(rows[i]);
            return { price, rows: list };
        },
    };
}

/** Strict Pareto reduction on (price asc, score desc, length asc). Value search only. */
function paretoSkyline(gpuNames, gpus, gpuCount) {
    const items = gpuNames.map((name) => ({
        name, gpu: gpus[name], p: gpus[name].price,
        G: S.gpuScore(gpus[name], gpuCount), L: gpus[name].length,
    }));
    const keep = [];
    for (const a of items) {
        let dominated = false;
        for (const b of items) {
            if (b === a) continue;
            if (b.p <= a.p && b.G >= a.G && b.L <= a.L &&
                (b.p < a.p || b.G > a.G || b.L < a.L)) { dominated = true; break; }
        }
        if (!dominated) keep.push(a);
    }
    return keep;
}

function buildModes(gpuNames, gpus, params) {
    const filter = spec.gpuCountFilter(params);
    const modes = [];
    if (filter == null || filter === 1) {
        modes.push({
            key: 'single', n: 1, needSAtx: false, names: gpuNames,
            compat: () => true,
        });
    }
    if (filter == null || filter === 2) {
        const groups = new Map();
        for (const name of gpuNames) {
            const gpu = gpus[name];
            if (gpu.multiGPU == null) continue;
            const key = gpu.multiGPU + '|' + gpu.realSlotSize;
            let group = groups.get(key);
            if (!group) {
                group = {
                    key: 'dual:' + key, n: 2, needSAtx: gpu.realSlotSize > 2, names: [],
                    maxSlotSize: gpu.realSlotSize, multiGPU: gpu.multiGPU,
                };
                groups.set(key, group);
            }
            group.names.push(name);
        }
        const sorted = Array.from(groups.values())
            .sort((a, b) => a.key.localeCompare(b.key));
        for (const group of sorted) {
            group.compat = (mobo) => {
                if (mobo.dualGpuMaxSlotSize == null) return false;
                if (mobo.dualGpuMaxSlotSize < group.maxSlotSize) return false;
                if (group.multiGPU === 'SLI') return mobo.supportSLI === 'Yes';
                if (group.multiGPU === 'CrossFire') return mobo.supportCrossfire === 'Yes';
                return false;
            };
            modes.push(group);
        }
    }
    return modes;
}

/* ------------------------------------------------------------------ context */

function makeContext(catalog, pools, params) {
    const ramNames = Object.keys(pools.rams);
    const gpuNames = Object.keys(pools.gpus);
    const cpuNames = Object.keys(pools.cpus);
    const moboNames = Object.keys(pools.mobos);

    const lengthSet = new Set();
    for (const name of gpuNames) lengthSet.add(pools.gpus[name].length);
    const lengths = Array.from(lengthSet).sort((a, b) => a - b);
    const lengthIndex = new Map(lengths.map((v, i) => [v, i]));

    const ramIndex = buildRamIndex(pools.rams);
    const caseIndex = buildCaseIndex(pools.pcCases, lengths);
    const modes = buildModes(gpuNames, pools.gpus, params);
    for (const mode of modes) mode.skyline = paretoSkyline(mode.names, pools.gpus, mode.n);

    const sockets = new Map();
    for (const name of cpuNames) {
        const cpu = pools.cpus[name];
        let entry = sockets.get(cpu.cpuSocket);
        if (!entry) { entry = { socket: cpu.cpuSocket, cpus: {}, maxChannels: 0 }; sockets.set(cpu.cpuSocket, entry); }
        entry.cpus[name] = cpu;
        entry.maxChannels = Math.max(entry.maxChannels, cpu.maxMemoryChannels);
    }
    for (const entry of sockets.values()) {
        entry.mobos = moboNames.filter((name) => spec.moboSupportsCpu(pools.mobos[name], { cpuSocket: entry.socket }));
        entry.speeds = usableSpeeds(catalog, entry.socket, pools.rams);
    }

    return {
        pools, params, modes, ramIndex, caseIndex, lengths, lengthIndex, sockets,
        budgetEff: spec.effectiveBudget(params),
        T: params.targetScore || 0,
        resultsRequested: params.resultsRequested == null ? 15 : params.resultsRequested,
        envelopeCache: new Map(),
        cpuTableCache: new Map(),
    };
}

/** Mobo candidate set + exact completion envelope for one (context, mode). */
function contextEnvelope(ctx, socketEntry, ramChannel, ramSpeed, mode) {
    const cacheKey = socketEntry.socket + '|' + ramChannel + '|' + ramSpeed + '|' + mode.key;
    const cached = ctx.envelopeCache.get(cacheKey);
    if (cached) return cached;

    const requiredStickGB = spec.ramStickRequirement(ctx.params, ramChannel);
    const mset = [];
    for (const name of socketEntry.mobos) {
        const mobo = ctx.pools.mobos[name];
        if (mobo.ramSlots < ramChannel) continue;
        if (!spec.moboSupportsSpeed(mobo, ramSpeed)) continue;
        if (!mode.compat(mobo)) continue;
        mset.push(name);
    }

    const byFormFactor = new Map();
    for (const name of mset) {
        const mobo = ctx.pools.mobos[name];
        const ramPrice = ctx.ramIndex.price(mobo.ramType, ramSpeed, requiredStickGB);
        if (!Number.isFinite(ramPrice)) continue;
        const value = mobo.price + ramChannel * ramPrice;
        const current = byFormFactor.get(mobo.motherboardSize);
        if (current === undefined || value < current) byFormFactor.set(mobo.motherboardSize, value);
    }

    const raw = new Array(ctx.lengths.length);
    const formFactors = [];
    for (const [formFactor, base] of byFormFactor) {
        formFactors.push({ base, bestByLength: ctx.caseIndex.table(formFactor, mode.needSAtx).bestByLength });
    }
    for (let i = 0; i < ctx.lengths.length; i++) {
        let best = Infinity;
        for (let f = 0; f < formFactors.length; f++) {
            const casePrice = formFactors[f].bestByLength[i];
            if (!Number.isFinite(casePrice)) continue;
            const value = formFactors[f].base + casePrice;
            if (value < best) best = value;
        }
        raw[i] = best;
    }
    const env = new Array(ctx.lengths.length);
    let running = Infinity;
    for (let i = ctx.lengths.length - 1; i >= 0; i--) {
        running = Math.min(running, raw[i]);
        env[i] = running;
    }

    const entry = {
        mset, requiredStickGB, byFormFactor, env,
        completionAt(length) {
            const i = ctx.lengthIndex.get(length);
            return i === undefined ? Infinity : env[i];
        },
    };
    ctx.envelopeCache.set(cacheKey, entry);
    return entry;
}

function cpuTableFor(ctx, socketEntry, ramChannel, ramSpeed) {
    const cacheKey = socketEntry.socket + '|' + ramChannel + '|' + ramSpeed;
    let table = ctx.cpuTableCache.get(cacheKey);
    if (!table) {
        table = buildCpuTable(socketEntry.cpus, ramChannel, ramSpeed);
        ctx.cpuTableCache.set(cacheKey, table);
    }
    return table;
}

/* --------------------------------------------------------------- pass 1/2 */

function findOptimalPrice(ctx) {
    let best = Infinity;
    for (const socketEntry of ctx.sockets.values()) {
        for (let ramChannel = 1; ramChannel <= socketEntry.maxChannels; ramChannel++) {
            for (const ramSpeed of socketEntry.speeds) {
                const cpuTable = cpuTableFor(ctx, socketEntry, ramChannel, ramSpeed);
                for (const mode of ctx.modes) {
                    const envelope = contextEnvelope(ctx, socketEntry, ramChannel, ramSpeed, mode);
                    if (!envelope.mset.length) continue;
                    let modeBest = Infinity;
                    for (const item of mode.skyline) {
                        const requiredCpuScore = S.minCpuScoreForGpuScore(item.G, ctx.T);
                        if (!Number.isFinite(requiredCpuScore)) continue;
                        const cpuChoice = cpuTable.best(requiredCpuScore);
                        if (!cpuChoice) continue;
                        const completion = envelope.completionAt(item.L);
                        if (!Number.isFinite(completion)) continue;
                        const total = cpuChoice.price + mode.n * item.p + completion;
                        if (total > ctx.budgetEff) continue;
                        if (total < modeBest) modeBest = total;
                        if (total < best) best = total;
                    }
                    // Exact per-(context, mode) minimum.  Any context whose minimum
                    // is above the global optimum cannot contain an optimal
                    // assembly, so pass 2 can skip it entirely.
                    envelope.modeMin = modeBest;
                }
            }
        }
    }
    return best;
}

function enumerateOptima(ctx, optimalPrice) {
    const raw = [];
    const gpus = ctx.pools.gpus;

    for (const socketEntry of ctx.sockets.values()) {
        for (let ramChannel = 1; ramChannel <= socketEntry.maxChannels; ramChannel++) {
            for (const ramSpeed of socketEntry.speeds) {
                const cpuTable = cpuTableFor(ctx, socketEntry, ramChannel, ramSpeed);
                for (const mode of ctx.modes) {
                    const envelope = contextEnvelope(ctx, socketEntry, ramChannel, ramSpeed, mode);
                    if (!envelope.mset.length) continue;
                    if (envelope.modeMin > optimalPrice) continue;   // cannot reach the tier
                    for (const gpuName of mode.names) {           // full list, not the skyline
                        const gpu = gpus[gpuName];
                        const G = S.gpuScore(gpu, mode.n);
                        const requiredCpuScore = S.minCpuScoreForGpuScore(G, ctx.T);
                        if (!Number.isFinite(requiredCpuScore)) continue;
                        const cpuChoice = cpuTable.bestWithTies(requiredCpuScore);
                        if (!cpuChoice) continue;
                        const head = cpuChoice.price + mode.n * gpu.price;
                        if (head + envelope.completionAt(gpu.length) !== optimalPrice) continue;
                        const residual = optimalPrice - head;

                        for (const moboName of envelope.mset) {
                            const mobo = ctx.pools.mobos[moboName];
                            const ramPrice = ctx.ramIndex.price(mobo.ramType, ramSpeed, envelope.requiredStickGB);
                            const casePrice = ctx.caseIndex.price(
                                mobo.motherboardSize, mode.needSAtx, gpu.length);
                            if (mobo.price + ramChannel * ramPrice + casePrice !== residual) continue;
                            const ramChoices = ctx.ramIndex.argmin(
                                mobo.ramType, ramSpeed, envelope.requiredStickGB);
                            const caseChoices = ctx.caseIndex.argmin(
                                mobo.motherboardSize, mode.needSAtx, gpu.length);
                            for (const cpuRow of cpuChoice.rows) {
                                for (const ramEntry of ramChoices) {
                                    for (const caseEntry of caseChoices) {
                                        raw.push({
                                            cpu: cpuRow.name,
                                            mobo: moboName,
                                            ram: ramEntry.name,
                                            pcCase: caseEntry.name,
                                            gpu: gpuName,
                                            vram: gpu.vramGB,
                                            gpuCount: mode.n,
                                            ramChannel,
                                            ramSpeed,
                                            price: optimalPrice,
                                            cpuScoreValue: cpuRow.score,
                                            gpuScoreValue: G,
                                            score: S.systemScore(cpuRow.score, G),
                                            watts: S.systemWatts(cpuRow.cpu, gpu, mode.n),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return raw;
}

function fastSolveBuildMaker(catalog, pools, params) {
    const ctx = makeContext(catalog, pools, params);
    const optimalPrice = findOptimalPrice(ctx);
    if (!Number.isFinite(optimalPrice)) return { price: Infinity, solutions: [] };
    const raw = enumerateOptima(ctx, optimalPrice);
    return finalizeSolutions(raw, optimalPrice, ctx.resultsRequested);
}

module.exports = {
    fastSolveBuildMaker,
    solveBuildMaker: fastSolveBuildMaker,
    // exported for tests / instrumentation
    _internals: { buildRamIndex, buildCaseIndex, buildCpuTable, paretoSkyline, makeContext },
};
