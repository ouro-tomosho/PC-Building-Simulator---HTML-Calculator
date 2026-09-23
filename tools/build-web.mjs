#!/usr/bin/env node
/*
 * Bundles src/ + web/ + data/catalog.json into a single self-contained HTML file at
 * the project root, named after the project (PCBS-Calculator.html) -- the same "double-click
 * it, no server, no network" property the original calculator had, but built from a
 * normal multi-file project.
 *
 * src/ is CommonJS (so Node can require it directly); this script wraps every module
 * in a registry and emits a 40-line loader, so there is exactly one source of truth
 * for the solver logic.
 *
 *   node tools/build-web.mjs [--out PCBS-Calculator.html]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');
const WEB = path.join(ROOT, 'web');

/** Only the runtime modules are bundled; synth/fixtures/scenarios are test-only. */
const MODULES = [
    'score.js', 'util.js', 'spec.js', 'catalog.js',
    'fast.js', 'upgrader.js', 'verify.js', 'brute.js', 'index.js',
];

const WEB_SCRIPTS = ['components.js', 'pages.js', 'app.js'];

function read(file) {
    return fs.readFileSync(file, 'utf8');
}

/** Guard: inlined payloads must not terminate the surrounding <script> element. */
function assertInlineSafe(name, text) {
    if (/<\/script/i.test(text)) throw new Error(name + ' contains "</script" and cannot be inlined');
}

/**
 * Inject a payload at a marker.
 *
 * NEVER use a plain string as the replacement: `String.prototype.replace` expands
 * `$&`, `$\``, `$'` and `$$` inside the *replacement*, and the application code contains
 * hundreds of `'$' + ...` money-formatting expressions. A `$'` there silently expands
 * to "everything after the match" and shreds the injected script. A function
 * replacement is inserted literally, and the result is verified byte-for-byte.
 */
function inject(template, marker, payload) {
    const out = template.replace(marker, () => payload);
    if (out.indexOf(payload) < 0) {
        throw new Error('injection at ' + marker + ' was altered by replacement patterns');
    }
    return out;
}

function bundleCore() {
    const chunks = MODULES.map((file) => {
        const source = read(path.join(SRC, file));
        assertInlineSafe('src/' + file, source);
        return '    ' + JSON.stringify('./' + file) + ': function (module, exports, require) {\n' + source + '\n    }';
    });
    return [
        '(function (global) {',
        '  var modules = {',
        chunks.join(',\n'),
        '  };',
        '  var cache = {};',
        '  function resolve(id) {',
        '    if (modules[id]) return id;',
        '    if (modules[id + \'.js\']) return id + \'.js\';',
        '    throw new Error(\'module not found: \' + id);',
        '  }',
        '  function require(id) {',
        '    var key = resolve(id);',
        '    if (cache[key]) return cache[key].exports;',
        '    var module = { exports: {} };',
        '    cache[key] = module;',
        '    modules[key](module, module.exports, require);',
        '    return module.exports;',
        '  }',
        '  global.PCBS = require(\'./index.js\');',
        '})(typeof window !== \'undefined\' ? window : this);',
        '',
    ].join('\n');
}

export function buildWeb(outArg) {
    const outFile = path.resolve(ROOT, outArg || 'PCBS-Calculator.html');

    const catalogPath = path.join(ROOT, 'data', 'catalog.json');
    if (!fs.existsSync(catalogPath)) {
        throw new Error('data/catalog.json is missing');
    }
    const catalogJson = read(catalogPath);
    assertInlineSafe('data/catalog.json', catalogJson);

    const template = read(path.join(WEB, 'index.html'));
    const styles = read(path.join(WEB, 'styles.css'));
    const core = bundleCore();
    const scripts = WEB_SCRIPTS.map((file) => {
        const source = read(path.join(WEB, file));
        assertInlineSafe('web/' + file, source);
        return '<script>\n' + source + '\n</script>';
    }).join('\n');

    const meta = fs.existsSync(path.join(ROOT, 'data', 'catalog.meta.json'))
        ? JSON.parse(read(path.join(ROOT, 'data', 'catalog.meta.json')))
        : {};

    let html = inject(template, '<!--STYLES-->', '<style>\n' + styles + '\n</style>');
    html = inject(html, '<!--CATALOG-->', '<script>window.PCBS_CATALOG_META = ' + JSON.stringify(meta) +
        ';\nwindow.PCBS_CATALOG = ' + catalogJson + ';</script>');
    html = inject(html, '<!--CORE-->', '<script>\n' + core + '\n</script>');
    html = inject(html, '<!--APP-->', scripts);

    // Every application script must survive injection byte-for-byte.
    for (const payload of [styles, core, catalogJson, scripts]) {
        if (html.indexOf(payload) < 0) throw new Error('a build payload was corrupted during injection');
    }

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html);

    const kb = (fs.statSync(outFile).size / 1048576).toFixed(2);
    console.log('wrote ' + path.relative(ROOT, outFile) + ' (' + kb + ' MB, self-contained)');
    return { outFile };
}

function main() {
    const outIndex = process.argv.indexOf('--out');
    try {
        buildWeb(outIndex > -1 ? process.argv[outIndex + 1] : 'PCBS-Calculator.html');
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    }
}

if (process.argv[1] && process.argv[1].endsWith('build-web.mjs')) main();
