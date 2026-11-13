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
		post: async (path, body) => post(path, body),
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
	harness.emit(session, turnStart());
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

test('模型给很多行时，默认最多保留 3 条', async () => {
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

// ---------- I. 工具结果进输入（②） ----------

/** 一轮完整流程：turn/start → 用户 → 助手 → 工具 → turn/end。 */
function playTurnWithTool(h, session, { turn = 1, failed = true } = {}) {
	h.emit(session, turnStart());
	h.emit(session, userMsg('把这个改一下'));
	h.emit(session, assistantMsg('改完了，跑一下测试。'));
	h.emit(session, { type: 'tool/call', data: { name: 'Bash', callId: 'c1', step: 1, turn } });
	h.emit(session, { type: 'tool/result', data: { message: { isError: failed, toolCallId: 'c1' }, step: 1, turn } });
	h.emit(session, turnEnd(turn));
}

const requestText = (call) => call.messages[0].content.map((b) => b.text).join('\n');

test('把本轮最后一步的工具结果喂给模型（失败）', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurnWithTool(h, session, { failed: true });
	await waitForSuggestion(h, session.id);

	assert.equal(h.streamCalls.length, 1);
	const sent = requestText(h.streamCalls[0]);
	assert.match(sent, /最后一步/, '输入里应当带上最后一步');
	assert.match(sent, /Bash/, '应当带上工具名');
	assert.match(sent, /失败/, '失败要如实标注');
});

test('工具成功时标注成功', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurnWithTool(h, session, { failed: false });
	await waitForSuggestion(h, session.id);

	assert.match(requestText(h.streamCalls[0]), /成功/);
});

test('新一轮开始后，上一轮的工具结论不会带进来', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurnWithTool(h, session, { turn: 1, failed: true });
	await waitForSuggestion(h, session.id);

	// 第二轮没有工具调用
	playTurn(h, session, { turn: 2 });
	await new Promise((r) => setTimeout(r, 30));
	const last = requestText(h.streamCalls[h.streamCalls.length - 1]);
	assert.doesNotMatch(last, /最后一步/, '上一轮的工具结论应当已作废');
});

// ---------- J. 同一回合只生成一次（④） ----------

test('同一回合重复 turn/end 不会再花一次 token', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurn(h, session, { turn: 1 });
	await waitForSuggestion(h, session.id);
	assert.equal(h.streamCalls.length, 1);

	h.emit(session, turnEnd(1));
	await settle();
	assert.equal(h.streamCalls.length, 1, '同一回合不该重复调用');
});

test('下一回合照常生成（去重是按回合，不是按会话）', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurn(h, session, { turn: 1 });
	await waitForSuggestion(h, session.id);

	h.emit(session, turnEnd(2));
	await settle();
	assert.equal(h.streamCalls.length, 2);
});

// ---------- K. 历史预算瘦身（④） ----------

test('历史只带最近 2 条用户消息', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	// 连续 4 轮，让历史积累起来
	for (const turn of [1, 2, 3, 4]) {
		h.emit(session, userMsg(`第${turn}句`));
		h.emit(session, assistantMsg('好。'));
		h.emit(session, turnEnd(turn));
		await settle();
	}
	const last = requestText(h.streamCalls[h.streamCalls.length - 1]);
	const historyLines = last.split('\n').filter((l) => l.startsWith('- 第'));
	assert.equal(historyLines.length, 2, '历史只保留最近 2 条');
});

// ---------- L. 输出上限（③） ----------

test('输出上限默认 512，够放 3 条长建议', async () => {
	const h = await freshHarness();
	const { config } = await h.readConfig();
	assert.equal(config.maxOutputTokens, 512);
});

test('思考档位为 off 时，请求的输出上限用配置值', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurn(h, session);
	await waitForSuggestion(h, session.id);
	assert.equal(h.streamCalls[0].maxTokens, 512);
});

// ---------- M. 命中率统计（①） ----------

const statsOf = async (h) => (await h.post('/api/suggest-bar/stats', {})).stats;

/** 统计文件是跨用例共享的，评估类用例开始前先清空。 */
const resetFeedback = () => writeFileSync(join(DATA_DIR, 'feedback.jsonl'), '', 'utf8');

test('用户发出的下一句与建议完全一致 → 记为 exact 命中', async () => {
	resetFeedback();
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurn(h, session);
	await waitForSuggestion(h, session.id);

	h.emit(session, turnStart());
	h.emit(session, userMsg('先跑测试'));

	const stats = await statsOf(h);
	assert.equal(stats.total, 1);
	assert.equal(stats.exact, 1);
	assert.equal(stats.exactRate, 100);
	assert.equal(stats.byIndex[0], 1, '命中的是第 1 条');
});

test('采用后又改了字 → 记为 prefix（部分命中）', async () => {
	resetFeedback();
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurn(h, session);
	await waitForSuggestion(h, session.id);

	h.emit(session, turnStart());
	h.emit(session, userMsg('先跑测试吧，跑完贴结果'));

	const stats = await statsOf(h);
	assert.equal(stats.prefix, 1);
	assert.equal(stats.exact, 0);
	assert.equal(stats.usefulRate, 100);
});

test('用户说了完全不相干的话 → 记为 miss', async () => {
	resetFeedback();
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurn(h, session);
	await waitForSuggestion(h, session.id);

	h.emit(session, turnStart());
	h.emit(session, userMsg('算了，先别弄这个了'));

	const stats = await statsOf(h);
	assert.equal(stats.miss, 1);
	assert.equal(stats.exactRate, 0);
});

test('没出建议的回合不参与统计（NONE 不算 miss）', async () => {
	resetFeedback();
	const h = await freshHarness({ reply: 'NONE' });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);
	await settle();

	h.emit(session, turnStart());
	h.emit(session, userMsg('随便说点别的'));
	await settle();

	const stats = await statsOf(h);
	assert.equal(stats.total, 0, '没有建议就没有可评估的对象');
});

test('统计在多次回合上累计', async () => {
	resetFeedback();
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	playTurn(h, session, { turn: 1 });
	await waitForSuggestion(h, session.id);
	h.emit(session, turnStart());
	h.emit(session, userMsg('先跑测试'));

	h.emit(session, assistantMsg('跑完了。'));
	h.emit(session, turnEnd(2));
	await waitForSuggestion(h, session.id);
	h.emit(session, turnStart());
	h.emit(session, userMsg('完全不同的要求'));

	const stats = await statsOf(h);
	assert.equal(stats.total, 2);
	assert.equal(stats.exact, 1);
	assert.equal(stats.miss, 1);
	assert.equal(stats.exactRate, 50);
});

// ---------- N. 并发会话隔离 ----------

test('另一个会话开始新一轮，不会清掉本会话在途的工具名', async () => {
	const h = await freshHarness();
	const a = nextSession(ROUTE_A);
	const b = nextSession(ROUTE_A);

	// A 一轮里并行调了两个工具，结果会乱序回来
	h.emit(a, turnStart());
	h.emit(a, userMsg('查一下再跑一下'));
	h.emit(a, assistantMsg('我并行做两件事。'));
	h.emit(a, { type: 'tool/call', data: { name: 'Read', callId: 'a1', step: 1, turn: 1 } });
	h.emit(a, { type: 'tool/call', data: { name: 'Bash', callId: 'a2', step: 1, turn: 1 } });

	// B 此时开始新一轮（以前这会把 A 的在途映射一起清掉）
	h.emit(b, turnStart());

	// A 的第一个调用（Read）先回来，且失败
	h.emit(a, { type: 'tool/result', data: { message: { isError: true, toolCallId: 'a1' }, step: 1, turn: 1 } });
	h.emit(a, turnEnd(1));

	const sent = requestText((await waitForSuggestion(h, a.id), h.streamCalls[h.streamCalls.length - 1]));
	assert.match(sent, /Read/, '应当是 Read 的结果，而不是被后一个工具名覆盖');
	assert.doesNotMatch(sent, /最后一步\] Bash/, '不该错误地标成 Bash');
	assert.match(sent, /失败/);
});

// ---------- O. 候选条数可配置 ----------

test('把最多几条建议调到 5，就收 5 条', async () => {
	const h = await freshHarness({ reply: '一\n二\n三\n四\n五\n六\n七' });
	await h.writeConfig({ maxSuggestions: 5 });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);

	const suggestion = await waitForSuggestion(h, session.id);
	assert.deepEqual(suggestion.texts, ['一', '二', '三', '四', '五']);
});

test('调到 2 条就只收 2 条', async () => {
	const h = await freshHarness({ reply: '一\n二\n三' });
	await h.writeConfig({ maxSuggestions: 2 });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);

	const suggestion = await waitForSuggestion(h, session.id);
	assert.deepEqual(suggestion.texts, ['一', '二']);
});

test('条数会写进提示词，模型才知道要给几条', async () => {
	const h = await freshHarness();
	await h.writeConfig({ maxSuggestions: 4 });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);
	await waitForSuggestion(h, session.id);

	assert.match(h.streamCalls[0].system, /最多输出 4 行/, '提示词里应当带上配置的条数');
});

test('条数调大时，输出上限自动抬到放得下（防止最后一条被截断）', async () => {
	const h = await freshHarness();
	await h.writeConfig({ maxSuggestions: 5, maxSuggestionChars: 120 });
	const session = nextSession(ROUTE_A);
	playTurn(h, session);
	await waitForSuggestion(h, session.id);

	// 5 × 120 × 1.2 = 720，高于配置里的 512
	assert.equal(h.streamCalls[0].maxTokens, 720);
});

test('条数超出范围会被钳到 1..6', async () => {
	const h = await freshHarness();
	const big = await h.writeConfig({ maxSuggestions: 99 });
	assert.equal(big.config.maxSuggestions, 6);
	const zero = await h.writeConfig({ maxSuggestions: 0 });
	assert.equal(zero.config.maxSuggestions, 1);
});

// ---------- P. 占位符去噪 ----------

test('代码块占位符不再进输入，但正文一字不丢', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	h.emit(session, turnStart());
	h.emit(session, userMsg('改一下'));
	// 真实形态：占位符后面紧跟正文（同一行），且正文里带收尾提问
	h.emit(session, assistantMsg(
		'第一段正文。\n```sh\necho a\n```第二段正文。\n```sh\necho b\n```第三段正文，要我提交吗？',
	));
	h.emit(session, turnEnd(1));
	await waitForSuggestion(h, session.id);

	const sent = requestText(h.streamCalls[0]);
	assert.equal((sent.match(/\[代码块\]/g) || []).length, 0, '占位符不该占预算');
	assert.match(sent, /第一段正文/);
	assert.match(sent, /第二段正文/);
	assert.match(sent, /第三段正文，要我提交吗/, '和占位符同行的正文必须保留');
});

test('助手回复只有代码块时，仍保留一个占位符（不变成空）', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	h.emit(session, turnStart());
	h.emit(session, userMsg('看看这个'));
	h.emit(session, assistantMsg('```sh\nls\n```'));
	h.emit(session, turnEnd(1));
	await waitForSuggestion(h, session.id);

	const sent = requestText(h.streamCalls[0]);
	assert.equal((sent.match(/\[代码块\]/g) || []).length, 1, '整段只有代码块时留一个标记');
});

test('几十个代码块不再把输入预算吃光', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	h.emit(session, turnStart());
	h.emit(session, userMsg('改一下'));
	const many = Array.from({ length: 30 }, (_, i) => `第${i}段正文。\n\`\`\`sh\necho ${i}\n\`\`\``).join('\n');
	h.emit(session, assistantMsg(`${many}\n收尾：下一步要我提交吗？`));
	h.emit(session, turnEnd(1));
	await waitForSuggestion(h, session.id);

	const sent = requestText(h.streamCalls[0]);
	assert.equal((sent.match(/\[代码块\]/g) || []).length, 0);
	assert.match(sent, /收尾：下一步要我提交吗/, '结尾正文必须还在');
	// 30 个占位符若不去掉，光标记就要 30 × 5 = 150 字符
	assert.ok(sent.length < 1500, `输入应当被压下来，实际 ${sent.length} 字符`);
});

test('表格占位符同样不占预算', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	h.emit(session, turnStart());
	h.emit(session, userMsg('看表'));
	h.emit(session, assistantMsg('| a | b |\n| - | - |\n| 1 | 2 |\n表格下面的正文。'));
	h.emit(session, turnEnd(1));
	await waitForSuggestion(h, session.id);

	const sent = requestText(h.streamCalls[0]);
	assert.equal((sent.match(/\[表格\]/g) || []).length, 0);
	assert.match(sent, /表格下面的正文/);
});

// ---------- Q. 工具调用说明清理 ----------

/** U+2060 零宽连接符：真实数据里工具说明标记的锚点。 */
const CAP = '\u2060';
const cap = (glyph, tool, tail) => `${glyph}${CAP} ${tool}${tail}`;

test('工具调用说明不再进输入（❯ Bash · Result）', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	h.emit(session, turnStart());
	h.emit(session, userMsg('改一下'));
	h.emit(session, assistantMsg('先看看代码。\n``` ' + cap('❯', 'Bash', ' · Result') + '\n跑通了，要我提交吗？'));
	h.emit(session, turnEnd(1));
	await waitForSuggestion(h, session.id);

	const sent = requestText(h.streamCalls[0]);
	assert.ok(!sent.includes(CAP), '零宽锚点不该出现');
	assert.match(sent, /先看看代码/, '说明前面的正文要保留');
	assert.match(sent, /跑通了，要我提交吗/, '说明后面的正文要保留');
});

test('同一行连续多个说明一并清掉，正文不受影响', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	h.emit(session, turnStart());
	h.emit(session, userMsg('看截图'));
	// 真实形态：一行里连着两个说明
	h.emit(session, assistantMsg(
		'两站都看得见烟： ' + cap('▤', 'Read', ' `/tmp/a.png`') + ' ' + cap('▤', 'Read', ' · Result'),
	));
	h.emit(session, turnEnd(1));
	await waitForSuggestion(h, session.id);

	const sent = requestText(h.streamCalls[0]);
	assert.ok(!sent.includes(CAP), '两个说明都该被清掉');
	assert.match(sent, /两站都看得见烟/, '正文保留');
});

test('✎ 和 ▤ 两种标记同样清掉', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	h.emit(session, turnStart());
	h.emit(session, userMsg('写文件'));
	h.emit(session, assistantMsg(
		'写好了： ' + cap('✎', 'Write', ' `/tmp/x.ts`') + '\n读了配置： ' + cap('▤', 'Read', ' `/tmp/y.json`'),
	));
	h.emit(session, turnEnd(1));
	await waitForSuggestion(h, session.id);

	const sent = requestText(h.streamCalls[0]);
	assert.ok(!sent.includes(CAP));
	assert.match(sent, /写好了/);
	assert.match(sent, /读了配置/);
});

test('只有工具说明、没有正文时，助手侧不会变成空', async () => {
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	h.emit(session, turnStart());
	h.emit(session, userMsg('跑一下'));
	h.emit(session, assistantMsg('``` ' + cap('❯', 'Bash', ' · Result')));
	h.emit(session, turnEnd(1));
	await waitForSuggestion(h, session.id);

	// 不该因为助手侧为空而跳过生成
	assert.equal(h.streamCalls.length, 1, '助手侧被清空后仍应发起生成');
});

test('正文里单独出现的标记字符不被当成工具说明', async () => {
	// 这里 ❯/✎/▤ 后面没有 U+2060，是普通正文（比如在讲符号含义），不能被当成说明删掉
	const h = await freshHarness();
	const session = nextSession(ROUTE_A);
	h.emit(session, turnStart());
	h.emit(session, userMsg('讲讲符号'));
	h.emit(session, assistantMsg('用 ❯ 表示命令提示符，用 ✎ 表示写入，后面这段是正文，必须保留。'));
	h.emit(session, turnEnd(1));
	await waitForSuggestion(h, session.id);

	const sent = requestText(h.streamCalls[0]);
	assert.match(sent, /后面这段是正文，必须保留/, '裸标记字符后面的正文不能丢');
});
