// host 侧行为测试
//
// 原则：只断言「外部能看到的结果」——路由返回什么、llm 有没有被调用、落盘文件里有什么。
// 不断言提示词原文、不断言内部 Map 结构，避免把实现细节写死进测试。
//
// 隔离：数据目录用 SUGGEST_BAR_DATA_DIR 指到临时目录，绝不读写插件目录里真实的
// config.json / suggestions.json。注意必须在 import 之前设置（模块加载时读这个变量）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'suggest-bar-test-'));
process.env.SUGGEST_BAR_DATA_DIR = DATA_DIR;

// 插件自己会往 stdout 打探针日志，测试里静音，只保留其他输出
const realLog = console.log;
console.log = (...args) => {
	if (typeof args[0] === 'string' && args[0].startsWith('[suggest-bar]')) return;
	realLog(...args);
};

const { apply } = await import('../index.js');

const ROUTE = '/api/suggest-bar';
const CONFIG_ROUTE = '/api/suggest-bar/config';
const OPTIONS_ROUTE = '/api/suggest-bar/options';

// ---------- 假 ctx ----------

/**
 * 造一个够用的 ctx。
 * reply 可以是字符串、chunk 数组、或 (opts) => chunks|Error 的函数。
 * streamCalls 记录每次 llm.stream 的入参，用来断言「该不该调用」。
 */
function makeCtx({ reply = '默认建议', providers = [], models = {}, modelInfo } = {}) {
	const routes = new Map();
	const disposers = [];
	const handlers = new Map();
	const streamCalls = [];

	const ctx = {
		llm: {
			resolveModelInfo: async (provider, model) => {
				if (modelInfo) return modelInfo(provider, model);
				return { reasoning: { efforts: [{ id: 'off' }] } };
			},
			stream: async function* (opts) {
				streamCalls.push(opts);
				const out = typeof reply === 'function' ? reply(opts) : reply;
				if (out instanceof Error) throw out;
				const chunks = typeof out === 'string'
					? [
						{ type: 'text-delta', index: 0, text: out },
						{ type: 'finish', reason: { kind: 'stop' } },
					]
					: out;
				for (const chunk of chunks) yield chunk;
			},
			listProviders: () => providers,
			listModels: async (providerId) => models[providerId] ?? [],
		},
		on: (event, handler) => { handlers.set(event, handler); },
		effect: (fn) => {
			const result = fn();
			if (typeof result === 'function') disposers.push(result);
		},
		connection: {
			fetch: {
				register: (route) => {
					routes.set(route.path, route);
					return () => routes.delete(route.path);
				},
			},
		},
	};

	const post = async (path, body) => {
		const route = routes.get(path);
		assert.ok(route, `路由未注册: ${path}`);
		const res = await route.fetch(new Request(`http://localhost${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body ?? {}),
		}));
		return res.json();
	};

	return {
		ctx,
		streamCalls,
		emit: (session, event) => {
			const handler = handlers.get('session/event');
			assert.ok(handler, '未注册 session/event 处理器');
			handler(session, event);
		},
		unmount: () => { for (const d of disposers) d(); },
		readSuggestion: async (sessionId) => (await post(ROUTE, { sessionId })).suggestion,
		readConfig: async () => post(CONFIG_ROUTE, {}),
		writeConfig: async (patch) => post(CONFIG_ROUTE, patch),
		readOptions: async () => post(OPTIONS_ROUTE, {}),
	};
}

// ---------- 事件构造 ----------

const sessionWith = (id, route) => ({
	id,
	requestHeader: () => (route ? { config: route } : {}),
});

const userMsg = (text) => ({
	type: 'user/message',
	data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
});

const assistantMsg = (text) => ({
	type: 'assistant/message',
	data: { message: { content: [{ type: 'text', text }] } },
});

const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });
const turnStart = () => ({ type: 'turn/start', data: {} });

/** 走完一轮用户→助手→回合结束，触发一次生成。 */
function playTurn(harness, session, { turn = 1, user = '把这个改一下', assistant = '改好了。' } = {}) {
	harness.emit(session, userMsg(user));
	harness.emit(session, assistantMsg(assistant));
	harness.emit(session, turnEnd(turn));
}

/** 生成是 fire-and-forget，这里轮询外部可见结果，等它出现。 */
async function waitForSuggestion(harness, sessionId, timeoutMs = 2000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const suggestion = await harness.readSuggestion(sessionId);
		if (suggestion !== null) return suggestion;
		await new Promise((r) => setTimeout(r, 10));
	}
	return null;
}

/** 给「不该发生」的断言留出反应时间。 */
const settle = () => new Promise((r) => setTimeout(r, 30));

let seq = 0;
const nextSession = (route) => sessionWith(`s-${++seq}`, route);

const ROUTE_A = { provider: 'p', model: 'm' };

/** 每个用例都从一份干净配置开始（配置落在临时目录里）。 */
async function freshHarness(opts = {}) {
	const harness = makeCtx({ reply: '先跑测试\n再提交', ...opts });
	apply(harness.ctx, { enabled: true, provider: 'p', model: 'm' });
	await harness.writeConfig({ enabled: true, provider: 'p', model: 'm', skipProviders: [], debug: false });
	return harness;
}

// ---------- A. 正常路径 ----------

test('回合正常结束：生成建议并可从路由读到', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurn(h, session);

	const suggestion = await waitForSuggestion(h, session.id);
	assert.ok(suggestion, '应当能读到建议');
	assert.equal(suggestion.turn, 1);
	assert.deepEqual(suggestion.texts, ['先跑测试', '再提交']);
	assert.equal(h.streamCalls.length, 1);
	assert.equal(h.streamCalls[0].provider, 'p');
	assert.equal(h.streamCalls[0].model, 'm');
});

test('模型给很多行时，最多保留 3 条', async () => {
	const h = await freshHarness({ reply: '一\n二\n三\n四\n五' });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);

	const suggestion = await waitForSuggestion(h, session.id);
	assert.deepEqual(suggestion.texts, ['一', '二', '三']);
});

test('模型没把握（NONE）时不出卡', async () => {
	const h = await freshHarness({ reply: 'NONE' });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);

	await settle();
	assert.equal(await h.readSuggestion(session.id), null);
});

// ---------- B. 解析契约 ----------

test('去掉序号、项目符号和包裹引号', async () => {
	const h = await freshHarness({ reply: '- 第一句\n1. 第二句\n「第三句」' });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);

	const suggestion = await waitForSuggestion(h, session.id);
	assert.deepEqual(suggestion.texts, ['第一句', '第二句', '第三句']);
});

test('丢掉确认词、表格、标题和助手腔的行', async () => {
	const h = await freshHarness({ reply: '好的\n| a | b |\n## 标题\n作为助手，我建议先跑测试\n真正的一句' });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);

	const suggestion = await waitForSuggestion(h, session.id);
	assert.deepEqual(suggestion.texts, ['真正的一句']);
});

test('超长建议按 maxSuggestionChars 截断', async () => {
	const h = await freshHarness({ reply: '这是一句相当长的建议内容需要被截断处理' });
	await h.writeConfig({ maxSuggestionChars: 10 });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);

	const suggestion = await waitForSuggestion(h, session.id);
	assert.equal(suggestion.texts[0].length, 10);
});

// ---------- C. 不该生成的场景 ----------

test('回合非正常结束时不生成', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	h.emit(session, userMsg('随便说点什么'));
	h.emit(session, turnEnd(1, 'aborted'));

	await settle();
	assert.equal(h.streamCalls.length, 0);
	assert.equal(await h.readSuggestion(session.id), null);
});

test('插件被关掉时不生成', async () => {
	const h = await freshHarness();
	await h.writeConfig({ enabled: false });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);

	await settle();
	assert.equal(h.streamCalls.length, 0);
});

test('会话主模型在 skipProviders 里时不生成', async () => {
	const h = await freshHarness();
	await h.writeConfig({ skipProviders: ['claude-code'] });
	const session = nextSession({ provider: 'claude-code', model: 'x' });
	playTurn(h, session);

	await settle();
	assert.equal(h.streamCalls.length, 0);
});

test('没有任何可用路由时不生成、也不报错', async () => {
	const h = await freshHarness();
	await h.writeConfig({ provider: '', model: '' });
	const session = sessionWith(`s-${++seq}`, null);
	playTurn(h, session);

	await settle();
	assert.equal(h.streamCalls.length, 0);
	assert.equal(await h.readSuggestion(session.id), null);
});

test('没有用户消息时（如只有助手回复）不生成', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	h.emit(session, assistantMsg('我先说一句。'));
	h.emit(session, turnEnd(1));

	await settle();
	assert.equal(h.streamCalls.length, 0);
});

// ---------- D. 作废与读取门控 ----------

test('用户发话后旧建议被作废，不会在回合中止后复现', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurn(h, session);
	assert.ok(await waitForSuggestion(h, session.id), '先要有建议');

	// 用户发话 → 旧建议作废；这一轮以 aborted 结束，running 归 false。
	// 若没作废，下面会读到上一轮的旧建议。
	h.emit(session, turnStart());
	h.emit(session, turnEnd(2, 'aborted'));

	assert.equal(await h.readSuggestion(session.id), null, '旧建议不该复现');
});

test('未知会话读到 null', async () => {
	const h = await freshHarness();
	assert.equal(await h.readSuggestion('从来没出现过的会话'), null);
});

// ---------- E. 配置路由 ----------

test('配置路由：读得到当前配置', async () => {
	const h = await freshHarness();
	const { config } = await h.readConfig();
	assert.equal(config.enabled, true);
	assert.equal(config.provider, 'p');
	assert.equal(config.labelText, '建议');
});

test('配置路由：写入后能读回，非法值被规整', async () => {
	const h = await freshHarness();
	const { config } = await h.writeConfig({ labelText: '下一句', timeoutMs: 1, generateMode: '瞎写的' });
	assert.equal(config.labelText, '下一句');
	assert.equal(config.timeoutMs, 60000, '过小的超时应回到默认值');
	assert.equal(config.generateMode, 'always', '非法生成时机应回到 always');
});

test('配置路由：改动下一回合生效（标签文案透传到建议里）', async () => {
	const h = await freshHarness();
	await h.writeConfig({ labelText: '下一句' });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);

	const suggestion = await waitForSuggestion(h, session.id);
	assert.equal(suggestion.label, '下一句');
});

// ---------- F. options 路由 ----------

test('options 路由枚举 provider 与模型', async () => {
	const h = await freshHarness({
		providers: [{ id: 'p1', name: 'Provider One' }, { id: 'p2' }],
		models: { p1: [{ id: 'm1', name: 'Model One' }], p2: [] },
	});
	const { providers } = await h.readOptions();
	assert.deepEqual(providers, [
		{ id: 'p1', models: [{ id: 'm1', name: 'Model One' }] },
		{ id: 'p2', models: [] },
	]);
});

// ---------- G. 路由候选回退 ----------

test('配置的路由失败时，回退到会话自己的路由', async () => {
	const h = await freshHarness({
		reply: (opts) => (opts.provider === 'broken'
			? new Error('model not found')
			: '回退成功的一句'),
	});
	await h.writeConfig({ provider: 'broken', model: 'nope' });
	const session = nextSession({ provider: 'good', model: 'ok' });
	playTurn(h, session);

	const suggestion = await waitForSuggestion(h, session.id);
	assert.ok(suggestion, '应当回退到会话路由并成功');
	assert.deepEqual(suggestion.texts, ['回退成功的一句']);
	assert.deepEqual(h.streamCalls.map((c) => c.provider), ['broken', 'good']);
});

// ---------- H. 落盘与重启 ----------

test('建议会被防抖写进数据目录的 suggestions.json', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurn(h, session, { turn: 7 });
	assert.ok(await waitForSuggestion(h, session.id));

	// 落盘是 500ms 防抖，等它自然写完，不靠卸载兜底
	await new Promise((r) => setTimeout(r, 700));

	const saved = JSON.parse(readFileSync(join(DATA_DIR, 'suggestions.json'), 'utf8'));
	assert.deepEqual(saved[session.id], { turn: 7, texts: ['先跑测试', '再提交'] });
});

test('卸载时把还没到防抖时间的建议也落盘', async () => {
	const h = await freshHarness();

	// 先让上一条建议走完防抖，把定时器清干净，这样下面只剩「卸载」这一条路径能写盘
	const warmup = nextSession(ROUTE_A);
	playTurn(h, warmup, { turn: 1 });
	assert.ok(await waitForSuggestion(h, warmup.id));
	await new Promise((r) => setTimeout(r, 700));

	// 新一条建议刚写进内存就卸载：500ms 防抖还没到
	const session = nextSession(ROUTE_A);
	playTurn(h, session, { turn: 2 });
	assert.ok(await waitForSuggestion(h, session.id));
	h.unmount();

	const saved = JSON.parse(readFileSync(join(DATA_DIR, 'suggestions.json'), 'utf8'));
	assert.deepEqual(saved[session.id], { turn: 2, texts: ['先跑测试', '再提交'] });
});

test('重启后能从 suggestions.json 恢复建议（含旧版单条格式）', async () => {
	writeFileSync(
		join(DATA_DIR, 'suggestions.json'),
		JSON.stringify({
			'legacy-session': { turn: 3, text: '旧格式的一条建议' },
			'new-session': { turn: 4, texts: ['新格式一', '新格式二'] },
		}),
		'utf8',
	);

	const h = makeCtx();
	apply(h.ctx, { enabled: true, provider: 'p', model: 'm' });

	assert.deepEqual((await h.readSuggestion('legacy-session')).texts, ['旧格式的一条建议']);
	assert.deepEqual((await h.readSuggestion('new-session')).texts, ['新格式一', '新格式二']);
	h.unmount();
});
