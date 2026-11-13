// 调试日志：轮转与开关
//
// 单独一个文件是为了拿到干净的模块状态（node --test 每个文件一个进程），
// 这样可以直接验证「超限时轮转」和「关掉后彻底安静」这两条。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'suggest-bar-debug-'));
process.env.SUGGEST_BAR_DATA_DIR = DATA_DIR;

const DEBUG_LOG = join(DATA_DIR, 'debug.log');
const DEBUG_PREV = join(DATA_DIR, 'debug.log.1');
const CONFIG = join(DATA_DIR, 'config.json');
const MAX_BYTES = 2 * 1024 * 1024;

// 捕获插件往 stdout 写的内容，同时静音，避免刷屏
let stdoutLines = 0;
const realLog = console.log;
console.log = (...args) => {
	if (typeof args[0] === 'string' && args[0].startsWith('[suggest-bar]')) { stdoutLines += 1; return; }
	realLog(...args);
};

const { apply } = await import('../index.js');

/** 够用的假 ctx：这些用例只关心日志，不关心生成。 */
const makeCtx = () => ({
	llm: {
		resolveModelInfo: async () => ({}),
		stream: async function* () {},
		listProviders: () => [],
		listModels: async () => [],
	},
	on: () => {},
	effect: (fn) => { fn(); },
	connection: { fetch: { register: () => () => {} } },
});

const setDebug = (on) => {
	writeFileSync(CONFIG, JSON.stringify({ debug: on }), 'utf8');
	// 配置按 mtime 感知缓存，等一毫秒确保 mtime 真的变了
	const until = Date.now() + 5;
	while (Date.now() < until) { /* spin */ }
};

test('调试关闭时完全不写 stdout', () => {
	setDebug(false);
	stdoutLines = 0;
	apply(makeCtx(), {});
	assert.equal(stdoutLines, 0, '关掉调试后不该再往 stdout 写任何东西');
});

test('调试开启时会写 stdout', () => {
	setDebug(true);
	stdoutLines = 0;
	apply(makeCtx(), {});
	assert.ok(stdoutLines > 0, '开着调试应当有输出');
});

test('超过 2MB 时轮转成 debug.log.1，而不是把历史清空丢掉', () => {
	setDebug(true);
	const old = `${'x'.repeat(MAX_BYTES)}TAIL-MARKER`;
	writeFileSync(DEBUG_LOG, old, 'utf8');

	apply(makeCtx(), {});

	assert.ok(existsSync(DEBUG_PREV), '应当生成 debug.log.1');
	assert.equal(readFileSync(DEBUG_PREV, 'utf8'), old, '旧内容应当被完整保留');
	assert.ok(statSync(DEBUG_LOG).size < 64 * 1024, '新文件应当重新开始写');
});

test('再轮转一次会覆盖上一份 debug.log.1（只留一代）', () => {
	setDebug(true);
	writeFileSync(DEBUG_PREV, 'GEN-1', 'utf8');
	writeFileSync(DEBUG_LOG, 'y'.repeat(MAX_BYTES + 10), 'utf8');

	apply(makeCtx(), {});

	assert.equal(readFileSync(DEBUG_PREV, 'utf8').length, MAX_BYTES + 10, 'debug.log.1 应当是刚轮转过来的那份');
	assert.ok(!readFileSync(DEBUG_PREV, 'utf8').includes('GEN-1'), '上一代不该再保留');
});

test('未超限时不轮转', () => {
	setDebug(true);
	writeFileSync(DEBUG_LOG, 'small\n', 'utf8');
	const before = existsSync(DEBUG_PREV) ? readFileSync(DEBUG_PREV, 'utf8') : null;

	apply(makeCtx(), {});

	if (before === null) assert.ok(!existsSync(DEBUG_PREV), '没超限不该产生 debug.log.1');
	else assert.equal(readFileSync(DEBUG_PREV, 'utf8'), before, '没超限不该动已有的 debug.log.1');
	assert.ok(readFileSync(DEBUG_LOG, 'utf8').includes('small'), '原有内容应当保留');
});
