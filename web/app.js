/* global window, document, PCBS, UI, Pages */
/*
 * 应用入口：零件表、生涯门槛、本地持久化、导航与页面共享上下文。
 *
 * 整个应用被设计成可以在单文件 dist/index.html 中直接双击运行：不联网、不需要服务器。
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'pcbs-calculator/v1';
    const catalog = window.PCBS_CATALOG;

    if (!catalog) {
        document.body.innerHTML = '<div class="empty">缺少零件数据。请运行 <code>npm run build</code> 重新生成 dist/index.html。</div>';
        return;
    }

    /* --------------------------------------------------------- 本地持久化 */

    const memory = {};
    const storage = {
        get(key, fallback) {
            try {
                const raw = window.localStorage.getItem(key);
                return raw == null ? fallback : JSON.parse(raw);
            } catch (err) {
                return key in memory ? memory[key] : fallback;
            }
        },
        set(key, value) {
            memory[key] = value;
            try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* file:// 或隐私模式 */ }
        },
    };

    const persisted = storage.get(STORAGE_KEY, {});
    const state = {
        gate: Object.assign({ allUnlocked: true, level: 0, levelPercentThroughSet: false, levelPercentThrough: 0 }, persisted.gate),
        page: (window.location.hash || '#buildMaker').slice(1),
        forms: persisted.forms || {},
        theme: persisted.theme || 'dark',
    };

    function persist() {
        storage.set(STORAGE_KEY, { gate: state.gate, forms: state.forms, theme: state.theme });
    }

    /* ------------------------------------------------------------- 零件池 */

    function pools() {
        return PCBS.catalog.basePools(catalog, state.gate);
    }

    /* --------------------------------------------------------------- 导航 */

    const nav = document.getElementById('nav');
    const pageRoot = document.getElementById('page');

    function buildNav() {
        UI.clear(nav);
        for (const page of Pages.list) {
            nav.appendChild(UI.h('button', {
                class: 'nav-item', type: 'button', dataset: { page: page.id },
                'aria-current': state.page === page.id ? 'page' : null,
                onclick: () => { window.location.hash = '#' + page.id; },
            }, [
                UI.h('span', { class: 'nav-title', text: page.title }),
                UI.h('span', { class: 'nav-desc', text: page.navHint || '' }),
            ]));
        }
    }

    let currentForm = null;
    let persistTimer = null;

    function readFormDom(formEl) {
        const out = {};
        for (const el of formEl.elements) {
            if (!el.name) continue;
            out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        }
        return out;
    }

    function mount(pageId) {
        const page = Pages.list.find((p) => p.id === pageId) || Pages.list[0];
        state.page = page.id;
        document.getElementById('pageTitle').textContent = page.title;
        document.getElementById('pageSubtitle').textContent = page.subtitle;
        document.title = page.title + ' — PCBS计算器';
        for (const item of nav.children) {
            if (item.dataset.page === page.id) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        }
        UI.clear(pageRoot);
        currentForm = null;
        page.mount(pageRoot, ctx);
        currentForm = pageRoot.querySelector('form');
        if (currentForm) {
            currentForm.addEventListener('input', schedulePersist);
            currentForm.addEventListener('change', schedulePersist);
        }
    }

    function schedulePersist() {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            if (currentForm) {
                state.forms[state.page] = readFormDom(currentForm);
                persist();
            }
        }, 250);
    }

    const ctx = {
        catalog,
        pools,
        form(id) { return state.forms[id]; },
        persistForm(id, values) { state.forms[id] = values; persist(); },
    };

    /* ----------------------------------------------------------- 等级门槛 */

    const allUnlocked = document.getElementById('allUnlocked');
    const levelInput = document.getElementById('level');
    const percentInput = document.getElementById('levelPercent');
    const poolChip = document.getElementById('poolChip');

    function syncGate() {
        state.gate.allUnlocked = allUnlocked.checked;
        state.gate.level = Number(levelInput.value) || 0;
        state.gate.levelPercentThroughSet = percentInput.value !== '';
        state.gate.levelPercentThrough = Number(percentInput.value) || 0;
        levelInput.disabled = allUnlocked.checked;
        percentInput.disabled = allUnlocked.checked;
        const p = pools();
        poolChip.textContent = '处理器 ' + Object.keys(p.cpus).length + ' · 显卡 ' + Object.keys(p.gpus).length +
            ' · 主板 ' + Object.keys(p.mobos).length + ' · 内存 ' + Object.keys(p.rams).length +
            ' · 机箱 ' + Object.keys(p.pcCases).length;
        persist();
    }

    allUnlocked.addEventListener('change', () => { syncGate(); mount(state.page); });
    levelInput.addEventListener('change', () => { syncGate(); mount(state.page); });
    percentInput.addEventListener('change', () => { syncGate(); mount(state.page); });

    /* --------------------------------------------------------------- 主题 */

    function applyTheme() {
        document.documentElement.setAttribute('data-theme', state.theme);
    }

    document.getElementById('themeToggle').addEventListener('click', () => {
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        applyTheme();
        persist();
    });

    document.getElementById('resetSettings').addEventListener('click', () => {
        state.forms = {};
        state.gate = { allUnlocked: true, level: 0, levelPercentThroughSet: false, levelPercentThrough: 0 };
        allUnlocked.checked = true;
        levelInput.value = '0';
        percentInput.value = '';
        syncGate();
        mount(state.page);
        UI.toast('设置已重置');
    });

    /* ---------------------------------------------------------------- 启动 */

    window.addEventListener('hashchange', () => {
        const id = (window.location.hash || '#buildMaker').slice(1);
        if (id !== state.page) mount(id);
    });

    document.getElementById('dataMeta').textContent =
        '等级门槛：' + (state.gate.allUnlocked ? '全部零件' : '等级 ' + state.gate.level);

    applyTheme();
    allUnlocked.checked = state.gate.allUnlocked;
    levelInput.value = state.gate.level;
    percentInput.value = state.gate.levelPercentThroughSet ? state.gate.levelPercentThrough : '';
    syncGate();
    buildNav();
    mount(state.page);
})();
