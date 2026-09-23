'use strict';
/*
 * 求解核心的对外 API。
 *
 * src/ 下全部是普通 CommonJS：既不依赖 DOM，也不依赖任何 Node 专有 API。
 * 因此同一份实现既能被 Node 测试直接 require，也能被 tools/build-web.mjs 原样打包进
 * 浏览器的单文件界面 —— 只有一个真源。
 */

const score = require('./score');
const util = require('./util');
const spec = require('./spec');
const catalog = require('./catalog');
const fast = require('./fast');
const upgrader = require('./upgrader');
const verify = require('./verify');
const brute = require('./brute');

module.exports = {
    version: '0.2.1',
    score,
    util,
    spec,
    catalog,
    fast,
    upgrader,
    verify,
    brute,
};
