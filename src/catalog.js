'use strict';
/*
 * 零件表加载。
 *
 * 数据来源：游戏内的 *Parts & Unlock Levels* 资源（经上游单文件计算器转换为 JSON），
 * 并且**已剔除 HEM 模组数据** —— 剔除数量与来源 SHA-256 记录在 data/catalog.meta.json。
 */

/** 上游按「插槽族」索引内存频率，两个插槽族共用一张表。 */
function ramSpeedKey(cpuSocket) {
    if (cpuSocket === 'LGA 1151 (Skylake)' || cpuSocket === 'LGA 1151 (Kaby Lake)') return 'LGA 1151 V1';
    if (cpuSocket === 'LGA 1151 (Coffee Lake)') return 'LGA 1151 V2';
    if (cpuSocket === 'SP3r1' || cpuSocket === 'SP3r2') return 'SP3';
    if (cpuSocket === 'SP3r1 (2P)' || cpuSocket === 'SP3r2 (2P)') return 'SP3 (2P)';
    return cpuSocket;
}

/** 等级门槛：全解锁，或等级高于该零件，或同等级且进度达标。 */
function partIsUnlocked(part, gate) {
    if (gate.allUnlocked) return true;
    if (!gate.level || gate.level <= 0) return true;
    if (gate.level > part.level) return true;
    if (gate.level < part.level) return false;
    if (!gate.levelPercentThroughSet) return true;
    return gate.levelPercentThrough >= part.levelPercentThrough;
}

const DIMENSIONS = ['cpus', 'gpus', 'mobos', 'rams', 'pcCases', 'storages'];

/**
 * 基准池：商店在售 + 等级已解锁。数据文件中已不含 HEM 零件，因此无需再判断。
 */
function basePools(catalog, gate) {
    gate = gate || { allUnlocked: true };
    const out = {};
    for (const dimension of DIMENSIONS) {
        out[dimension] = {};
        const parts = catalog[dimension] || {};
        for (const name in parts) {
            const part = parts[name];
            // 数据文件已剔除 HEM；这里再判一次，是为了让任何传入原始数据（含 HEM）的调用方
            // 也得到同样的结果，而不是悄悄把 HEM 零件放进候选池。
            if (part.isHEMPart === true) continue;
            if (part.inShop !== 'Yes') continue;
            if (!partIsUnlocked(part, gate)) continue;
            out[dimension][name] = part;
        }
    }
    return out;
}

/** 插槽 -> 可用内存频率（取自游戏频率表）。 */
function socketSpeedTable(catalog) {
    const table = (catalog.ramSpeeds && catalog.ramSpeeds.Base) || {};
    const out = {};
    for (const key in table) out[key] = Object.keys(table[key]).map(Number).sort((a, b) => a - b);
    return out;
}

/** 当前内存池中实际存在的频率。 */
function ramFrequencies(rams) {
    const seen = new Set();
    for (const name in rams) seen.add(rams[name].frequency);
    return Array.from(seen).sort((a, b) => a - b);
}

/**
 * 某个 CPU 插槽下可选的内存频率：游戏频率表 ∩ 内存池实际频率。
 * 频率表中没有该插槽时（合成测试数据）回退为内存池的全部频率。
 */
function usableSpeeds(catalog, cpuSocket, rams) {
    const table = socketSpeedTable(catalog)[ramSpeedKey(cpuSocket)];
    const offered = ramFrequencies(rams);
    if (!table || !table.length) return offered;
    const set = new Set(table);
    return offered.filter((frequency) => set.has(frequency));
}

module.exports = {
    ramSpeedKey,
    partIsUnlocked,
    basePools,
    socketSpeedTable,
    ramFrequencies,
    usableSpeeds,
    DIMENSIONS,
};
