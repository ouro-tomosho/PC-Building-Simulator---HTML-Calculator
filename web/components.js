/* global window, document */
/*
 * 界面用的轻量 DOM 工具。刻意使用经典脚本（非 ES 模块），
 * 这样打包出的单文件 dist/index.html 可以直接从 file:// 打开。
 */
window.UI = (function () {
    'use strict';

    const h = (tag, attrs, children) => {
        const node = document.createElement(tag);
        if (attrs) {
            for (const key in attrs) {
                const value = attrs[key];
                if (value == null || value === false) continue;
                if (key === 'class') node.className = value;
                else if (key === 'text') node.textContent = value;
                else if (key === 'html') node.innerHTML = value;
                else if (key === 'dataset') Object.assign(node.dataset, value);
                else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
                else if (value === true) node.setAttribute(key, '');
                else node.setAttribute(key, value);
            }
        }
        if (children != null) {
            for (const child of [].concat(children)) {
                if (child == null || child === false) continue;
                node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
            }
        }
        return node;
    };

    const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

    const num = (value) => {
        if (value == null || value === '' || Number.isNaN(Number(value))) return '—';
        if (!Number.isFinite(Number(value))) return '∞';
        return Number(value).toLocaleString('en-US');
    };

    let idSeed = 0;
    const nextId = (name) => 'f_' + name + '_' + (++idSeed);

    /* ------------------------------------------------------------ 控件 */

    function createControl(spec) {
        const id = nextId(spec.name);
        let input;
        if (spec.type === 'select') {
            input = h('select', { id, name: spec.name, disabled: spec.disabled });
            for (const option of spec.options || []) {
                const value = typeof option === 'object' ? option.value : option;
                const label = typeof option === 'object' ? option.label : String(option);
                input.appendChild(h('option', { value, text: label, selected: String(spec.value) === String(value) }));
            }
        } else if (spec.type === 'checkbox') {
            input = h('input', { id, name: spec.name, type: 'checkbox', checked: !!spec.value, disabled: spec.disabled });
        } else {
            input = h('input', {
                id, name: spec.name, type: spec.type || 'text',
                // 数值框一律不要右侧的上下箭头：这些字段靠键盘输入，箭头只会误触。
                class: spec.type === 'number' ? 'no-spin' : null,
                value: spec.value == null ? '' : spec.value,
                placeholder: spec.placeholder, min: spec.min, max: spec.max,
                // 数值字段一律 step="any"：否则像 1234 这种"步长不匹配"的值会被浏览器
                // 判定为非法并直接阻止表单提交（表现为按钮没反应）。
                step: spec.type === 'number' ? 'any' : spec.step,
                list: spec.datalist, disabled: spec.disabled, autocomplete: 'off', spellcheck: 'false',
            });
            if (spec.type === 'number') {
                // 指针悬停在数字框上滚动时不再改数值（先失焦，再阻止本次默认行为）。
                input.addEventListener('wheel', function (event) {
                    this.blur();
                    event.preventDefault();
                }, { passive: false });
            }
        }
        return { id, input, spec };
    }

    /** 普通一行：左侧标签，右侧控件（窄屏自动改为上下排列）。 */
    function renderRow(control) {
        const { spec, input, id } = control;
        const row = h('label', { class: 'field' + (spec.type === 'checkbox' ? ' check' : ''), for: id }, [
            h('span', { text: spec.label }),
            input,
        ]);
        if (spec.hint) row.appendChild(h('div', { class: 'hint', text: spec.hint }));
        return row;
    }

    /**
     * 「阈值 + 精确限定」联动分组。
     *
     * 输入框与勾选框被放进同一个带左边框的容器里：勾选后整组变绿并显示「精确匹配」，
     * 输入无效时整组虚线锁定并提示原因 —— 让「这个勾选框只作用于这个输入框」在视觉上
     * 一目了然。
     */
    function renderLimitRow(control, limitControl) {
        const state = h('span', { class: 'limit-state', text: '请输入库中已有的型号' });
        const toggle = h('label', { class: 'limit-toggle', for: limitControl.id }, [
            limitControl.input,
            h('span', { text: limitControl.spec.label }),
            state,
        ]);
        const group = h('div', { class: 'limit-group', dataset: { state: 'locked' } }, [
            h('label', { class: 'lg-label', for: control.id, text: control.spec.label }),
            control.input,
            toggle,
        ]);
        if (control.spec.hint) group.appendChild(h('div', { class: 'hint', style: 'grid-column: 2', text: control.spec.hint }));
        control.group = group;
        control.stateChip = state;
        return group;
    }

    /**
     * 章节右侧的说明框：用来在「需求」旁边解释三种查询模式，避免把长注释塞在输入框下面。
     *   { title, items: [{ name, desc }], foot }
     */
    function renderAside(aside) {
        const box = h('aside', { class: 'aside-box' }, [h('h3', { text: aside.title })]);
        for (const item of aside.items || []) {
            box.appendChild(h('div', { class: 'aside-item' }, [
                h('div', { class: 'aside-name', text: item.name }),
                h('div', { class: 'aside-desc', text: item.desc }),
            ]));
        }
        if (aside.foot) box.appendChild(h('div', { class: 'aside-foot', text: aside.foot }));
        return box;
    }

    /**
     * fields: 字段描述数组。
     *   { section: '需求' }                                      分组标题
     *   { section: '需求', aside: { … } }                        分组标题 + 右侧说明框
     *   { name, label, type, value, options, datalist, hint, … } 普通字段
     *   { name, label, …, limit: { name, label, value } }        阈值 + 精确限定
     */
    function form(fields, options) {
        options = options || {};
        const controls = [];
        const formEl = h('form', { class: 'card', novalidate: true, onsubmit: (event) => event.preventDefault() });
        if (options.title) formEl.appendChild(h('h2', { text: options.title }));
        let grid = h('div', { class: 'form-grid' });
        let aside = null;

        const flush = () => {
            if (!grid.childElementCount) return;
            if (aside) {
                formEl.appendChild(h('div', { class: 'form-split' }, [grid, renderAside(aside)]));
                aside = null;
            } else {
                formEl.appendChild(grid);
            }
        };

        for (const spec of fields) {
            if (spec.section) {
                flush();
                formEl.appendChild(h('h2', { class: 'section', text: spec.section }));
                grid = h('div', { class: 'form-grid' });
                if (spec.aside) aside = spec.aside;
                continue;
            }
            if (spec.limit) {
                const control = createControl(spec);
                const limitControl = createControl({
                    name: spec.limit.name, label: spec.limit.label, type: 'checkbox',
                    value: spec.limit.value, disabled: true,
                });
                controls.push(control, limitControl);
                grid.appendChild(renderLimitRow(control, limitControl));
                continue;
            }
            const control = createControl(spec);
            controls.push(control);
            grid.appendChild(renderRow(control));
        }
        flush();

        const read = () => {
            const out = {};
            for (const control of controls) {
                out[control.spec.name] = control.spec.type === 'checkbox'
                    ? control.input.checked
                    : control.input.value;
            }
            return out;
        };

        return { el: formEl, read, control: (name) => controls.find((c) => c.spec.name === name) };
    }

    /* ------------------------------------------------------------ 表格 */

    /** columns: [{ key, label, num?, wide?, render?(row) }] —— 点击表头排序。 */
    function table(columns, rows) {
        const state = { key: null, dir: 1 };
        const thead = h('thead');
        const tbody = h('tbody');
        const wrap = h('div', { class: 'table-wrap' }, h('table', { class: 'results' }, [thead, tbody]));

        const paint = () => {
            clear(tbody);
            for (const row of rows) {
                const tr = h('tr');
                for (const column of columns) {
                    const value = column.render ? column.render(row) : row[column.key];
                    const td = h('td', { class: (column.num ? 'num ' : '') + (column.wide ? 'wide' : '') });
                    if (value && typeof value === 'object' && value.nodeType) td.appendChild(value);
                    else td.textContent = value == null ? '' : String(value);
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
            }
        };

        const paintHead = () => {
            clear(thead);
            const tr = h('tr');
            for (const column of columns) {
                tr.appendChild(h('th', {
                    class: column.num ? 'num' : '',
                    text: column.label + (state.key === column.key ? (state.dir > 0 ? ' ↑' : ' ↓') : ''),
                    title: '按「' + column.label + '」排序',
                    onclick: () => {
                        if (state.key === column.key) state.dir = -state.dir;
                        else { state.key = column.key; state.dir = 1; }
                        const sorted = rows.slice().sort((a, b) => {
                            const av = a[column.key];
                            const bv = b[column.key];
                            if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * state.dir;
                            return String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv)) * state.dir;
                        });
                        rows.length = 0;
                        rows.push(...sorted);
                        paintHead();
                        paint();
                    },
                }));
            }
            thead.appendChild(tr);
        };

        paintHead();
        paint();
        return { el: wrap, rows };
    }

    /* ------------------------------------------------------------ 杂项 */

    function stats(items) {
        return h('div', { class: 'stat-row' }, items.filter(Boolean).map((item) =>
            h('div', { class: 'stat' + (item.accent ? ' accent' : '') }, [
                h('div', { class: 'k', text: item.k }),
                h('div', { class: 'v' + (item.small ? ' small' : ''), text: item.v }),
            ])));
    }

    function notice(kind, text) {
        return h('div', { class: 'notice ' + kind, text });
    }

    let toastTimer = null;
    function toast(message) {
        const node = document.getElementById('toast');
        if (!node) return;
        node.textContent = message;
        node.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove('show'), 1800);
    }

    function copy(text, label) {
        const done = () => toast(label || '已复制到剪贴板');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, () => fallback(text, done));
        } else {
            fallback(text, done);
        }
    }

    function fallback(text, done) {
        const area = h('textarea', { style: 'position:fixed;left:-9999px' });
        area.value = text;
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); done(); } catch (err) { toast('浏览器阻止了复制，请手动选中文本复制'); }
        document.body.removeChild(area);
    }

    return { h, clear, num, form, table, stats, notice, toast, copy };
})();
