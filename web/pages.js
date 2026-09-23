/* global window, document, PCBS, UI */
/*
 * 两个页面：配置生成器与升级生成器。
 *
 * 它们对应同一个标准问题（最便宜的可行配置 / 最便宜的升级）的两个实例：
 *   配置生成器 —— 五个槽位全部自由，成本为整机总价；
 *   升级生成器 —— 内存与机箱沿用原机，只更换 CPU / 主板 / 显卡，成本为边际价格。
 *
 * 两个页面共用同一套三种查询模式：
 *   只给预算            -> 预算内最便宜的可行方案
 *   只给目标分数        -> 恰好满足该分数的最少预算方案
 *   预算与目标分数都给  -> 预算以内、达到目标分数的最便宜方案
 */
window.Pages = (function () {
    'use strict';

    const h = UI.h;
    const clone = (obj) => JSON.parse(JSON.stringify(obj));
    const DIMENSIONS = ['cpus', 'gpus', 'mobos', 'rams', 'pcCases'];
    const ANY = 'Any';

    /* ------------------------------------------------------------ 通用工具 */

    function fillDatalist(id, names, pool, showPrice) {
        const list = document.getElementById(id);
        if (!list) return;
        UI.clear(list);
        for (const name of names) {
            const price = pool && pool[name] ? pool[name].price : null;
            list.appendChild(h('option', {
                value: name,
                text: showPrice && price != null ? name + '  （$' + price + '）' : name,
            }));
        }
    }

    function namesByPrice(pool) {
        return Object.keys(pool).sort((a, b) => pool[a].price - pool[b].price || a.localeCompare(b));
    }

    function distinct(pool, key) {
        const set = new Set();
        for (const name in pool) set.add(pool[name][key]);
        return Array.from(set).sort((a, b) => a - b);
    }

    /** 品牌候选来自**所有**部件维度，而不只是 CPU。 */
    function brandOptions(pools) {
        const set = new Set();
        for (const dimension of DIMENSIONS) {
            for (const name in pools[dimension]) set.add(pools[dimension][name].manufacturer);
        }
        return Array.from(set).filter(Boolean).sort();
    }

    /**
     * 把「精确限定」勾选框与相邻输入框绑定：输入无效时禁用并锁定分组，
     * 勾选后整组进入「精确匹配」状态。
     */
    function coupleLimit(control, checkbox, pool) {
        const sync = () => {
            const valid = !!(control.input.value.trim() && pool[control.input.value.trim()]);
            checkbox.input.disabled = !valid;
            if (!valid) checkbox.input.checked = false;
            if (control.group) {
                control.group.dataset.state = !valid ? 'locked' : (checkbox.input.checked ? 'exact' : 'threshold');
            }
            if (control.stateChip) {
                control.stateChip.textContent = !valid ? '请输入库中已有的型号' : (checkbox.input.checked ? '精确匹配' : '不低于');
            }
        };
        control.input.addEventListener('input', sync);
        control.input.addEventListener('change', sync);
        checkbox.input.addEventListener('change', sync);
        sync();
        return sync;
    }

    function busy(button, label, fn) {
        const original = button.textContent;
        button.disabled = true;
        button.textContent = label || '处理中…';
        setTimeout(() => {
            try { fn(); } finally { button.disabled = false; button.textContent = original; }
        }, 16);
    }

    /** 提交按钮 + 实时模式提示。 */
    function actionBar(button) {
        const hint = h('div', { class: 'mode-hint' });
        const bar = h('div', { class: 'actions' }, [button, hint]);
        return { el: bar, hint };
    }

    function resultHost(root) {
        const host = h('div');
        root.appendChild(host);
        return host;
    }

    function showNotice(host, kind, message) {
        UI.clear(host);
        host.appendChild(UI.notice(kind, message));
    }

    /** 数值框是否给出了有效值：留空或 0 都视为「未填写」。 */
    function hasNumber(raw) {
        if (String(raw == null ? '' : raw).trim() === '') return false;
        const value = Number(raw);
        return Number.isFinite(value) && value > 0;
    }

    /**
     * 三种查询模式：返回 { hasBudget, hasTarget, mode }，mode 为 '' 表示没有要求。
     * 「预算 = 0」与「预算留空」等价 —— 都表示不限预算。
     */
    function readMode(values) {
        const hasBudget = hasNumber(values.budget);
        const hasTarget = hasNumber(values.target);
        let mode = '';
        if (hasBudget && hasTarget) mode = 'both';
        else if (hasBudget) mode = 'budget';
        else if (hasTarget) mode = 'target';
        return { hasBudget, hasTarget, mode };
    }

    /** 预算不限时「预留预算」无从扣起，直接禁用该栏。 */
    function syncReserved(form) {
        const hasBudget = hasNumber(form.control('budget').input.value);
        form.control('reserved').input.disabled = !hasBudget;
        return hasBudget;
    }

    /** 「需求」右侧的说明框内容（两个页面共用，只改称谓）。 */
    function modeAside(noun) {
        return {
            title: '三种模式',
            items: [
                { name: '只填预算', desc: '输出预算内最便宜的可行' + noun + '。' },
                { name: '只填目标分数', desc: '不限预算上限，输出满足该分数及以上的最便宜' + noun + '。' },
                { name: '两者都填', desc: '输出预算以内、达到目标分数的最便宜' + noun + '。' },
            ],
            foot: '预算留空或填 0 都表示不限预算；此时「预留预算」失效。',
        };
    }

    /** 按钮旁的实时模式提示，措辞与「需求」右侧的说明卡保持一致。 */
    function modeText(noun) {
        return {
            budget: '只给了预算：输出预算内最便宜的可行' + noun + '。',
            target: '只给了目标分数：不限预算上限，输出满足该分数及以上的最便宜' + noun + '。',
            both: '给了预算与目标分数：输出预算以内、达到目标分数的最便宜' + noun + '。',
            '': '请至少填写「预算」或「目标分数」其中之一（填 0 等同于留空）。',
        };
    }

    function updateModeHint(hint, values, text) {
        const { mode } = readMode(values);
        hint.textContent = text[mode];
        hint.className = 'mode-hint' + (mode ? '' : ' bad');
        return mode;
    }

    function remainingText(budget, price) {
        if (!Number.isFinite(budget)) return '—';
        return '$' + UI.num(Math.max(0, budget - price));
    }

    /**
     * 升级结果表：**沿用原机**的部件只显示一个「-」。
     * 未更换的零件在升级语境里没有信息量，重复整机型号反而会淹没真正改动的那一格。
     */
    function partCell(value, originalValue) {
        return value === originalValue ? '-' : value;
    }

    function copyButton(text, label, title) {
        return h('button', {
            class: 'mini', type: 'button', text: label,
            onclick: (event) => {
                UI.copy(text, title);
                event.target.textContent = '已复制';
                setTimeout(() => { event.target.textContent = label; }, 900);
            },
        });
    }

    /* --------------------------------------------------- 1. 配置生成器 */

    const buildMaker = {
        id: 'buildMaker',
        title: '配置生成器',
        subtitle: '给定预算与目标分数，精确求出最便宜且互相兼容的完整配置，并列出该价格档的全部同价方案；只给目标分数时，输出满足该分数及以上的最便宜配置。',
        navHint: '预算 / 目标分数 → 最便宜的完整配置',
        mount(root, ctx) {
            const saved = ctx.form('buildMaker') || {};
            const val = (key, fallback) => (saved[key] != null ? saved[key] : fallback);
            const noun = '配置';
            const text = modeText(noun);

            const form = UI.form([
                { section: '需求', aside: modeAside(noun) },
                { name: 'budget', label: '预算', type: 'number', min: 0, value: val('budget', 1500), placeholder: '留空或 0 = 不限' },
                { name: 'reserved', label: '预留预算', type: 'number', min: 0, value: val('reserved', 100), hint: '为未建模的部件预留（风扇、存储、电源等），会从可用预算中扣除；预算不限时本栏失效。' },
                { name: 'target', label: '目标分数', type: 'number', min: 0, value: val('target', 6000), placeholder: '留空 = 不设分数要求' },
                { name: 'results', label: '结果条数', type: 'number', min: 1, value: val('results', 15) },

                { section: '筛选' },
                { name: 'overclock', label: 'CPU 与主板均需支持超频', type: 'checkbox', value: !!saved.overclock },
                { name: 'brand', label: '品牌', datalist: 'dlBmBrand', value: val('brand', ''), placeholder: '留空 = 不限' },

                { section: '处理器' },
                { name: 'socket', label: 'CPU 插槽', type: 'select', value: val('socket', ANY), options: [] },
                {
                    name: 'cpu', label: 'CPU 不低于', datalist: 'dlBmCpu', value: val('cpu', ''),
                    placeholder: '输入即检索…',
                    limit: { name: 'limitCpu', label: '精确限定为该 CPU', value: !!saved.limitCpu },
                },

                { section: '主板与内存' },
                { name: 'mobo', label: '指定主板', datalist: 'dlBmMobo', value: val('mobo', ''), placeholder: '留空 = 不限' },
                { name: 'memFreq', label: '内存频率不低于', type: 'select', value: val('memFreq', ANY), options: [] },
                { name: 'memSize', label: '系统内存不低于', type: 'select', value: val('memSize', ANY), options: [{ value: ANY, label: '不限' }, 8, 16, 32, 64, 128] },

                { section: '显卡' },
                { name: 'gpuCount', label: '显卡数量', type: 'select', value: val('gpuCount', ANY), options: [{ value: ANY, label: '不限' }, { value: 1, label: '单卡' }, { value: 2, label: '双卡' }] },
                { name: 'gpuType', label: '显卡类型', type: 'select', value: val('gpuType', ANY), options: [{ value: ANY, label: '不限' }, { value: 'Air', label: '风冷' }, { value: 'Water', label: '水冷' }] },
                { name: 'vram', label: '显存不低于', type: 'select', value: val('vram', ANY), options: [] },
                {
                    name: 'gpu', label: '显卡不低于', datalist: 'dlBmGpu', value: val('gpu', ''),
                    placeholder: '输入即检索…',
                    limit: { name: 'limitGpu', label: '精确限定为该显卡', value: !!saved.limitGpu },
                },

                { section: '机箱' },
                { name: 'pcCase', label: '指定机箱', datalist: 'dlBmCase', value: val('pcCase', ''), placeholder: '留空 = 不限' },
            ], { title: '查询条件' });

            const runButton = h('button', { class: 'primary', type: 'submit', text: '获取配置' });
            const bar = actionBar(runButton);
            form.el.appendChild(bar.el);
            root.appendChild(form.el);
            for (const id of ['dlBmCpu', 'dlBmGpu', 'dlBmMobo', 'dlBmCase', 'dlBmBrand']) root.appendChild(h('datalist', { id }));
            const host = resultHost(root);

            const syncLimits = [
                coupleLimit(form.control('cpu'), form.control('limitCpu'), ctx.pools().cpus),
                coupleLimit(form.control('gpu'), form.control('limitGpu'), ctx.pools().gpus),
            ];

            const params = () => {
                const v = form.read();
                const { hasBudget, hasTarget } = readMode(v);
                return {
                    budget: hasBudget ? Number(v.budget) : Infinity,
                    reserved: hasBudget ? (Number(v.reserved) || 0) : 0,
                    targetScore: hasTarget ? Number(v.target) : 0,
                    brand: v.brand.trim() || ANY, cpuSocket: v.socket || ANY,
                    needCpuOverclock: v.overclock,
                    minCpuName: v.cpu.trim() || null, limitCpu: v.limitCpu,
                    minGpuName: v.gpu.trim() || null, limitGpu: v.limitGpu,
                    minVramGB: v.vram === ANY ? null : Number(v.vram),
                    minSysRamGB: v.memSize === ANY ? null : Number(v.memSize),
                    minRamFrequency: v.memFreq === ANY ? null : Number(v.memFreq),
                    gpuType: v.gpuType || ANY,
                    // <select> 的值是字符串，必须转成数字：核心层按数值判断单卡/双卡。
                    gpuCount: v.gpuCount === ANY || v.gpuCount === '' ? ANY : Number(v.gpuCount),
                    moboName: v.mobo.trim() || null, caseName: v.pcCase.trim() || null,
                    resultsRequested: Math.max(1, Math.round(Number(v.results) || 15)),
                };
            };

            const refresh = () => {
                const base = ctx.pools();
                syncReserved(form);
                const narrowed = PCBS.spec.narrowPools(base, params());
                fillDatalist('dlBmBrand', brandOptions(base), null, false);
                fillDatalist('dlBmCpu', namesByPrice(narrowed.cpus), narrowed.cpus, true);
                fillDatalist('dlBmGpu', namesByPrice(narrowed.gpus), narrowed.gpus, true);
                fillDatalist('dlBmMobo', namesByPrice(narrowed.mobos), narrowed.mobos, true);
                fillDatalist('dlBmCase', namesByPrice(narrowed.pcCases), narrowed.pcCases, true);

                const socketSelect = form.control('socket').input;
                const keep = socketSelect.value;
                UI.clear(socketSelect);
                socketSelect.appendChild(h('option', { value: ANY, text: '不限' }));
                for (const socket of Array.from(new Set(Object.values(base.cpus).map((c) => c.cpuSocket))).sort()) {
                    socketSelect.appendChild(h('option', { value: socket, text: socket, selected: socket === keep }));
                }
                socketSelect.value = keep || ANY;

                const freqSelect = form.control('memFreq').input;
                const keepF = freqSelect.value;
                UI.clear(freqSelect);
                freqSelect.appendChild(h('option', { value: ANY, text: '不限' }));
                for (const frequency of distinct(narrowed.rams, 'frequency')) {
                    freqSelect.appendChild(h('option', { value: frequency, text: frequency + ' MHz', selected: String(frequency) === String(keepF) }));
                }

                const vramSelect = form.control('vram').input;
                const keepV = vramSelect.value;
                UI.clear(vramSelect);
                vramSelect.appendChild(h('option', { value: ANY, text: '不限' }));
                for (const vram of distinct(narrowed.gpus, 'vramGB')) {
                    vramSelect.appendChild(h('option', { value: vram, text: vram + ' GB', selected: String(vram) === String(keepV) }));
                }

                for (const sync of syncLimits) sync();
            };

            const run = () => {
                const values = form.read();
                const { mode } = readMode(values);
                ctx.persistForm('buildMaker', form.read());
                if (!mode) {
                    showNotice(host, 'bad', text['']);
                    return;
                }
                const p = params();
                const pools = PCBS.spec.narrowPools(ctx.pools(), p);
                const outcome = PCBS.fast.solveBuildMaker(ctx.catalog, pools, p);
                render(outcome, p, mode);
            };

            form.el.addEventListener('submit', (event) => { event.preventDefault(); busy(runButton, '求解中…', run); });
            for (const name of ['budget', 'reserved', 'target', 'results', 'brand', 'socket', 'overclock', 'cpu', 'mobo', 'memFreq', 'memSize', 'gpuType', 'gpuCount', 'vram', 'gpu', 'pcCase']) {
                const control = form.control(name);
                control.input.addEventListener('change', refresh);
                if (control.input.tagName === 'INPUT' && control.input.type === 'text') control.input.addEventListener('input', refresh);
            }
            form.el.addEventListener('input', () => updateModeHint(bar.hint, form.read(), text));
            form.el.addEventListener('change', () => updateModeHint(bar.hint, form.read(), text));

            /** 复制：六行纯文本，不含内存频率。 */
            const copyText = (row) => [row.cpu, row.mobo,
                row.ramChannel + ' ' + row.ram,
                row.gpuCount + ' ' + row.gpu, row.watts, row.pcCase].join('\n');

            const HEADING = {
                budget: '预算内最便宜配置',
                target: '满足目标分数及以上的最少预算档',
                both: '最优价格档',
            };

            const render = (outcome, p, mode) => {
                UI.clear(host);
                if (!Number.isFinite(outcome.price)) {
                    showNotice(host, 'bad', '未找到可行配置。可以尝试：提高预算、降低或清空目标分数，或放宽筛选条件。');
                    return;
                }
                const rows = outcome.solutions.map(clone);
                for (const row of rows) row.remaining = remainingText(p.budget, row.price);
                const first = rows[0];

                host.appendChild(h('div', { class: 'card' }, [
                    h('div', { class: 'results-head' }, [h('h2', { text: HEADING[mode] })]),
                    UI.stats([
                        { k: mode === 'target' ? '所需最少预算' : '最便宜可行配置', v: '$' + UI.num(outcome.price), accent: true },
                        { k: '3DMark 分数', v: UI.num(first.score) },
                        { k: '同价方案', v: UI.num(rows.length) },
                        Number.isFinite(p.budget) ? { k: '预算上限', v: '$' + UI.num(p.budget) } : null,
                    ]),
                    UI.table([
                        { key: 'pcCase', label: '机箱', wide: true },
                        { key: 'cpu', label: 'CPU', wide: true },
                        { key: 'mobo', label: '主板', wide: true },
                        { key: 'ramChannel', label: '条数', num: true },
                        { key: 'ramSpeed', label: '频率', num: true },
                        { key: 'ram', label: '内存', wide: true },
                        { key: 'gpuCount', label: '卡数', num: true },
                        { key: 'vram', label: '显存', num: true, render: (row) => (row.vram == null ? '—' : row.vram) },
                        { key: 'gpu', label: '显卡', wide: true },
                        { key: 'watts', label: '功耗', num: true },
                        { key: 'score', label: '分数', num: true },
                        { key: 'price', label: '价格', num: true, render: (row) => '$' + UI.num(row.price) },
                        { key: 'remaining', label: '剩余', num: true, render: (row) => (row.remaining === '—' ? '—' : row.remaining) },
                        { key: 'copy', label: '复制', render: (row) => copyButton(copyText(row), '复制', '配置已复制（6 行纯文本）') },
                    ], rows).el,
                ]));
            };

            refresh();
            updateModeHint(bar.hint, form.read(), text);
        },
    };

    /* --------------------------------------------------- 2. 升级生成器 */

    const upgrader = {
        id: 'upgrader',
        title: '升级生成器',
        subtitle: '现有主机的内存与机箱沿用不变，只更换 CPU、主板与显卡：哪套改动最便宜，且能让整机达到目标分数？只给目标分数时，输出满足该分数及以上的最便宜升级方案。',
        navHint: '现有主机 → 最便宜的升级方案',
        mount(root, ctx) {
            const saved = ctx.form('upgrader') || {};
            const val = (key, fallback) => (saved[key] != null ? saved[key] : fallback);
            const noun = '升级方案';
            const text = modeText(noun);
            const base = ctx.pools();
            const ramFrequencies = distinct(base.rams, 'frequency');
            // 现有主机的零件一律留空由用户填写；两个下拉框默认选中第一项。
            const defaultRamSpeed = ramFrequencies[0] || 2400;

            const form = UI.form([
                { section: '需求', aside: modeAside(noun) },
                { name: 'budget', label: '升级预算', type: 'number', min: 0, value: val('budget', 1000), placeholder: '留空或 0 = 不限' },
                { name: 'reserved', label: '预留预算', type: 'number', min: 0, value: val('reserved', 0), hint: '会从可用升级预算中扣除；预算不限时本栏失效。' },
                { name: 'target', label: '目标分数', type: 'number', min: 0, value: val('target', 8000), placeholder: '留空 = 不设分数要求' },
                { name: 'results', label: '结果条数', type: 'number', min: 1, value: val('results', 15) },

                { section: '现有主机' },
                { name: 'cpu', label: '当前 CPU', datalist: 'dlUpCpu', value: val('cpu', ''), placeholder: '输入即检索…' },
                { name: 'mobo', label: '当前主板', datalist: 'dlUpMobo', value: val('mobo', ''), placeholder: '输入即检索…' },
                { name: 'ramSpeed', label: '内存频率', type: 'select', value: val('ramSpeed', defaultRamSpeed), options: [] },
                { name: 'ramSticks', label: '内存条数', type: 'number', min: 1, value: val('ramSticks', 2) },
                { name: 'gpu', label: '当前显卡', datalist: 'dlUpGpu', value: val('gpu', ''), placeholder: '输入即检索…' },
                { name: 'gpuCount', label: '显卡数量', type: 'select', value: val('gpuCount', 1), options: [1, 2] },
                { name: 'pcCase', label: '现有机箱', datalist: 'dlUpCase', value: val('pcCase', ''), placeholder: '输入即检索…' },

                { section: '替换件的筛选' },
                { name: 'overclock', label: '更换的 CPU 与主板需支持超频', type: 'checkbox', value: !!saved.overclock },
                { name: 'brand', label: '品牌', datalist: 'dlUpBrand', value: val('brand', ''), placeholder: '留空 = 不限' },
                {
                    name: 'minCpu', label: 'CPU 不低于', datalist: 'dlUpCpu', value: val('minCpu', ''),
                    placeholder: '留空 = 不限',
                    limit: { name: 'limitCpu', label: '精确限定为该 CPU', value: !!saved.limitCpu },
                },
                { name: 'gpuCountFilter', label: '替换后显卡数量', type: 'select', value: val('gpuCountFilter', ANY), options: [{ value: ANY, label: '不限' }, { value: 1, label: '单卡' }, { value: 2, label: '双卡' }] },
                { name: 'gpuType', label: '显卡类型', type: 'select', value: val('gpuType', ANY), options: [{ value: ANY, label: '不限' }, { value: 'Air', label: '风冷' }, { value: 'Water', label: '水冷' }] },
                { name: 'vram', label: '显存不低于', type: 'select', value: val('vram', ANY), options: [] },
                {
                    name: 'minGpu', label: '显卡不低于', datalist: 'dlUpGpu', value: val('minGpu', ''),
                    placeholder: '留空 = 不限',
                    limit: { name: 'limitGpu', label: '精确限定为该显卡', value: !!saved.limitGpu },
                },
            ], { title: '查询条件' });

            const runButton = h('button', { class: 'primary', type: 'submit', text: '获取升级方案' });
            const bar = actionBar(runButton);
            form.el.appendChild(bar.el);
            root.appendChild(form.el);
            for (const id of ['dlUpCpu', 'dlUpGpu', 'dlUpMobo', 'dlUpCase', 'dlUpBrand']) root.appendChild(h('datalist', { id }));
            const host = resultHost(root);

            const syncLimits = [
                coupleLimit(form.control('minCpu'), form.control('limitCpu'), base.cpus),
                coupleLimit(form.control('minGpu'), form.control('limitGpu'), base.gpus),
            ];

            const params = () => {
                const v = form.read();
                const { hasBudget, hasTarget } = readMode(v);
                return {
                    budget: hasBudget ? Number(v.budget) : Infinity,
                    reserved: hasBudget ? (Number(v.reserved) || 0) : 0,
                    targetScore: hasTarget ? Number(v.target) : 0,
                    brand: v.brand.trim() || ANY, cpuSocket: ANY,
                    needCpuOverclock: v.overclock,
                    minCpuName: v.minCpu.trim() || null, limitCpu: v.limitCpu,
                    minGpuName: v.minGpu.trim() || null, limitGpu: v.limitGpu,
                    minVramGB: v.vram === ANY ? null : Number(v.vram),
                    minSysRamGB: null, minRamFrequency: null,
                    gpuType: v.gpuType || ANY,
                    gpuCount: v.gpuCountFilter === ANY || v.gpuCountFilter === '' ? ANY : Number(v.gpuCountFilter),
                    moboName: null, caseName: null,
                    resultsRequested: Math.max(1, Math.round(Number(v.results) || 15)),
                };
            };

            const refresh = () => {
                syncReserved(form);
                const narrowed = PCBS.spec.narrowPools(base, params());
                fillDatalist('dlUpCpu', namesByPrice(base.cpus), base.cpus, true);
                fillDatalist('dlUpGpu', namesByPrice(base.gpus), base.gpus, true);
                fillDatalist('dlUpMobo', namesByPrice(base.mobos), base.mobos, true);
                fillDatalist('dlUpCase', namesByPrice(base.pcCases), base.pcCases, true);
                fillDatalist('dlUpBrand', brandOptions(base), null, false);

                // 现有内存频率必须是库里的具体值（原机内存是既成事实，没有「不限」这一说）。
                const freqSelect = form.control('ramSpeed').input;
                const keepF = freqSelect.value;
                UI.clear(freqSelect);
                for (const frequency of ramFrequencies) {
                    freqSelect.appendChild(h('option', { value: frequency, text: frequency + ' MHz' }));
                }
                const keepIndex = ramFrequencies.findIndex((f) => String(f) === String(keepF));
                freqSelect.value = String(keepIndex >= 0 ? ramFrequencies[keepIndex] : defaultRamSpeed);

                const vramSelect = form.control('vram').input;
                const keepV = vramSelect.value;
                UI.clear(vramSelect);
                vramSelect.appendChild(h('option', { value: ANY, text: '不限' }));
                for (const vram of distinct(narrowed.gpus, 'vramGB')) {
                    vramSelect.appendChild(h('option', { value: vram, text: vram + ' GB', selected: String(vram) === String(keepV) }));
                }

                for (const sync of syncLimits) sync();
            };

            const run = () => {
                const v = form.read();
                const { mode } = readMode(v);
                ctx.persistForm('upgrader', form.read());
                if (!mode) { showNotice(host, 'bad', text['']); return; }

                const p = params();
                // 一律用「自有属性」查找：'__proto__' 这类名字不能命中原型链上的对象。
                const cpu = PCBS.spec.ownPart(base.cpus, v.cpu.trim());
                const mobo = PCBS.spec.ownPart(base.mobos, v.mobo.trim());
                const gpu = PCBS.spec.ownPart(base.gpus, v.gpu.trim());
                const pcCase = PCBS.spec.ownPart(base.pcCases, v.pcCase.trim());
                if (!cpu) { showNotice(host, 'bad', '未找到该 CPU。'); return; }
                if (!mobo) { showNotice(host, 'bad', '未找到该主板。'); return; }
                if (!gpu) { showNotice(host, 'bad', '未找到该显卡。'); return; }
                if (!v.pcCase.trim()) { showNotice(host, 'bad', '请填写现有机箱。'); return; }
                if (!pcCase) { showNotice(host, 'bad', '未找到该机箱。'); return; }

                const original = {
                    cpu: v.cpu.trim(), mobo: v.mobo.trim(), gpu: v.gpu.trim(),
                    gpuCount: Number(v.gpuCount),
                    ramSticks: Math.max(1, Math.round(Number(v.ramSticks) || 1)),
                    ramSpeed: Number(v.ramSpeed) || defaultRamSpeed,
                    ramType: mobo.ramType,
                    case: v.pcCase.trim(),
                };
                const pools = PCBS.spec.narrowPools(base, p);
                const outcome = PCBS.upgrader.solveBuildUpgrader(ctx.catalog, pools, original, p, {});
                render(outcome, p, mode, original);
            };

            form.el.addEventListener('submit', (event) => { event.preventDefault(); busy(runButton, '求解中…', run); });
            for (const name of ['budget', 'reserved', 'target', 'results', 'brand', 'overclock', 'gpuType', 'gpuCountFilter', 'vram', 'minCpu', 'minGpu']) {
                form.control(name).input.addEventListener('change', refresh);
            }
            form.el.addEventListener('input', () => updateModeHint(bar.hint, form.read(), text));
            form.el.addEventListener('change', () => updateModeHint(bar.hint, form.read(), text));

            const HEADING = {
                budget: '预算内最便宜升级',
                target: '满足目标分数及以上的最少预算升级档',
                both: '最低价升级档',
            };

            /** 复制：三行（CPU / 主板 / 显卡）；沿用原机的部件输出「-」。 */
            const copyText = (row, original) => [
                row.cpu === original.cpu ? '-' : row.cpu,
                row.mobo === original.mobo ? '-' : row.mobo,
                // 显卡：型号与数量都没变才算沿用；"加装同型号第二张卡"必须仍然写出张数。
                (row.gpu === original.gpu && row.gpuCount === original.gpuCount)
                    ? '-'
                    : (row.gpuCount > 1 ? row.gpuCount + ' × ' : '') + row.gpu,
            ].join('\n');

            const render = (outcome, p, mode, original) => {
                UI.clear(host);
                if (!Number.isFinite(outcome.price)) {
                    showNotice(host, 'bad', '未找到升级方案。可以提高预算、降低目标分数，或放宽筛选条件。');
                    return;
                }
                const rows = outcome.solutions.map(clone);
                const first = rows[0];
                const originalCpu = PCBS.spec.ownPart(base.cpus, original.cpu);
                const originalScore = PCBS.score.systemScore(
                    PCBS.score.cpuScore(originalCpu,
                        Math.min(original.ramSticks, originalCpu.maxMemoryChannels),
                        PCBS.upgrader.xmpSpeed(PCBS.spec.ownPart(base.mobos, original.mobo), original.ramSpeed)),
                    PCBS.score.gpuScore(PCBS.spec.ownPart(base.gpus, original.gpu), original.gpuCount)
                );

                host.appendChild(h('div', { class: 'card' }, [
                    h('div', { class: 'results-head' }, [h('h2', { text: HEADING[mode] })]),
                    UI.stats([
                        { k: mode === 'target' ? '所需最少预算' : '最便宜升级', v: '$' + UI.num(outcome.price), accent: true },
                        { k: '升级后分数', v: UI.num(first.score) },
                        { k: '现有主机分数', v: UI.num(originalScore) },
                        { k: '同价方案', v: UI.num(rows.length) },
                        Number.isFinite(p.budget) ? { k: '预算上限', v: '$' + UI.num(p.budget) } : null,
                    ]),
                    Number.isFinite(p.targetScore) && p.targetScore > 0 && originalScore >= p.targetScore
                        ? UI.notice('info', '现有主机已经达到目标分数，下面列出的是仍然最便宜的改动。')
                        : null,
                    // 内存不参与升级（条数与频率沿用现有主机），因此结果表只列真正会变的部件。
                    UI.table([
                        { key: 'cpu', label: 'CPU', wide: true, render: (row) => partCell(row.cpu, original.cpu) },
                        { key: 'mobo', label: '主板', wide: true, render: (row) => partCell(row.mobo, original.mobo) },
                        { key: 'gpuCount', label: '卡数', num: true },
                        { key: 'gpu', label: '显卡', wide: true, render: (row) => partCell(row.gpu, original.gpu) },
                        { key: 'watts', label: '功耗', num: true },
                        { key: 'score', label: '分数', num: true },
                        { key: 'price', label: '价格', num: true, render: (row) => '$' + UI.num(row.price) },
                        { key: 'remaining', label: '剩余', num: true, render: (row) => remainingText(p.budget, row.price) },
                        { key: 'copy', label: '复制', render: (row) => copyButton(copyText(row, original), '复制', '升级方案已复制（3 行纯文本）') },
                    ], rows).el,
                    h('div', { class: 'table-note', text: '「-」表示该零件沿用现有主机，未产生费用。' }),
                ]));
            };

            refresh();
            updateModeHint(bar.hint, form.read(), text);
        },
    };

    return { buildMaker, upgrader, list: [buildMaker, upgrader] };
})();
