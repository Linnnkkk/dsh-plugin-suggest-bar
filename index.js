/**
 * dsh-plugin-suggest-bar —— 输入框上方“建议”栏（自研 v0.4.0）
 *
 * 架构（两段式交互：回合结束后异步生成、下回合开始前作废）：
 *   1. 监听 session/event：turn/end(completed) 后 fire-and-forget 一次有界辅助
 *      LLM 调用，预测用户下一句；路由由 config.json 配置（首启由 yml 种子落盘）；
 *   2. 结果存注册表（落盘 suggestions.json，重启恢复），浏览器端 POST /api/suggest-bar 每 700ms 轮询读取；
 *   3. turn/start 即作废旧建议并中止在途生成（用户已开口，旧建议即失效）。
 *
 * v0.4.0：
 *   - 配置改为自管 config.json（本插件目录）：设置 UI 经 /api/suggest-bar/config
 *     读写，落盘持久化、改完下一回合生效；yml config 仅作首启种子。
 *     （不再依赖内核的 volatile 表单投影——那套在这台 0.2.2 上实测不出现。）
 *   - 设置 UI 走 settings.section 槽位（设置页独立一节）。
 *   - labelText 默认“建议”，全链路动态下发，无任何硬编码文案。
 *
 * 刻意的取舍：不写自定义会话事件（宿主事件校验会拒载整本日志）；建议持久化到独立 suggestions.json 而非会话日志。
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';

const name = 'dsh-plugin-suggest-bar';
const ROUTE_PATH = '/api/suggest-bar';
const CONFIG_ROUTE_PATH = '/api/suggest-bar/config';
const OPTIONS_ROUTE_PATH = '/api/suggest-bar/options';
const PURPOSE = 'suggest-bar';
const CONFIG_PATH = fileURLToPath(new URL('./config.json', import.meta.url));
const STORE_PATH = fileURLToPath(new URL('./suggestions.json', import.meta.url));
const STORE_MAX = 200;         // 持久化上限：只保留最近 N 个会话的建议

/** 服务依赖：loader 等 llm 与 connection 就绪后才装配本插件（对齐 dsh-suggest-ghost）。 */
const inject = ['llm', 'connection'];

/** yml 种子 schema（首启落盘用；此后以 config.json 为准）。 */
const Config = z.object({
	enabled: z.boolean().default(true),
	provider: z.string().default(''),
	model: z.string().default(''),
	skipProviders: z.array(z.string()).default([]),
	labelText: z.string().default('建议'),
	timeoutMs: z.natural().min(1000).default(60000),
	maxOutputTokens: z.natural().min(16).default(256),
	maxSuggestionChars: z.natural().min(10).default(120),
	maxInputBytes: z.natural().min(512).default(10240),
	debug: z.boolean().default(false),
});

/** 内存注册表（随 host 进程存活）。 */
const store = new Map();    // sessionId -> { turn: number, text: string }
const running = new Map();  // sessionId -> boolean
const pending = new Map();  // sessionId -> AbortController
const lastTurn = new Map(); // sessionId -> { user: string, assistant: string }
const warned = new Set();

/** 建议持久化：独立 suggestions.json（不写会话日志），host 重启后恢复；写盘 500ms 防抖。 */
function loadStore() {
	try {
		const data = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
		for (const [id, s] of Object.entries(data ?? {})) {
			if (s && Number.isInteger(s.turn) && typeof s.text === 'string' && s.text !== '') store.set(id, { turn: s.turn, text: s.text });
		}
	} catch { /* 首启或文件损坏：从空开始 */ }
}
let saveTimer;
function flushStore() {
	clearTimeout(saveTimer);
	saveTimer = undefined;
	try {
		writeFileSync(STORE_PATH, `${JSON.stringify(Object.fromEntries(store))}\n`, 'utf8');
	} catch (error) {
		dbg('store: 写盘失败:', error instanceof Error ? error.message : String(error));
	}
}
function saveStoreSoon() {
	if (saveTimer === undefined) saveTimer = setTimeout(flushStore, 500);
}
function setSuggestion(sessionId, value) {
	store.delete(sessionId); // 重新插入 → 保持 Map 按最近更新排序
	store.set(sessionId, value);
	while (store.size > STORE_MAX) store.delete(store.keys().next().value);
	saveStoreSoon();
}
function dropSuggestion(sessionId) {
	if (store.delete(sessionId)) saveStoreSoon();
}

/** 直写 stdout（dsh.log）的调试探针——不依赖 ctx.logger（实测 warn 不落盘）。 */
const dbg = (...args) => console.log('[suggest-bar]', ...args);

/** 任意来源（yml / config.json / 路由 patch）→ 规整后的有效配置。 */
function resolveConfig(c) {
	const numOr = (v, d, min) => {
		const n = Number(v);
		return Number.isFinite(n) && n >= min ? Math.floor(n) : d;
	};
	return {
		enabled: c?.enabled !== false,
		provider: typeof c?.provider === 'string' ? c.provider.trim() : '',
		model: typeof c?.model === 'string' ? c.model.trim() : '',
		skipProviders: Array.isArray(c?.skipProviders) ? c.skipProviders.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [],
		labelText: typeof c?.labelText === 'string' && c.labelText.trim() !== '' ? c.labelText.trim() : '建议',
		timeoutMs: numOr(c?.timeoutMs, 60000, 1000),
		maxOutputTokens: numOr(c?.maxOutputTokens, 256, 16),
		maxSuggestionChars: numOr(c?.maxSuggestionChars, 120, 10),
		maxInputBytes: numOr(c?.maxInputBytes, 10240, 512),
		debug: c?.debug === true,
	};
}

/** 自管配置：读 config.json（mtime 感知缓存）；首启用种子落盘一份。 */
let configCache = null;
let configMtime = 0;
function loadConfig(seed) {
	try {
		const st = statSync(CONFIG_PATH);
		if (configCache === null || st.mtimeMs !== configMtime) {
			configCache = resolveConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
			configMtime = st.mtimeMs;
		}
		return configCache;
	} catch {
		const initial = resolveConfig(seed);
		try {
			writeFileSync(CONFIG_PATH, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
			configCache = initial;
			configMtime = statSync(CONFIG_PATH).mtimeMs;
			dbg('config: 首启落盘', CONFIG_PATH);
		} catch (error) {
			configCache = initial;
			dbg('config: config.json 不可写，仅内存生效:', error instanceof Error ? error.message : String(error));
		}
		return configCache;
	}
}

/** 合并 patch → 校验类型 → 落盘并刷新缓存。 */
function saveConfig(seed, patch) {
	const next = resolveConfig({ ...loadConfig(seed), ...patch });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
	configCache = next;
	configMtime = statSync(CONFIG_PATH).mtimeMs;
	return next;
}

function textOfContent(content) {
	if (typeof content === 'string') return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
			.map((b) => b.text)
			.join(' ')
			.trim();
	}
	return '';
}

function noteTurn(sessionId, key, text) {
	const t = lastTurn.get(sessionId) ?? { user: '', assistant: '', history: [] };
	if (key === 'user' && t.user !== '' && t.user !== text) {
		t.history = [...t.history, t.user].slice(-3); // 之前几条用户消息：给模型看口吻和目标
		t.assistant = ''; // 新一轮开始，上一轮的助手回复作废
	}
	t[key] = text;
	lastTurn.set(sessionId, t);
}

/**
 * v2 提示词（2026-11-12 在 72 条真实会话样本上评测选出）：
 * 现行版爱出“好”“谢谢整理”这类空话；只加细节的版本又太长、爱把几件事串起来、编造细节。
 */
function systemPrompt(maxChars) {
	return [
		'你替用户预先写好他在 AI 编程助手里要发的下一条消息，显示在输入框上方，用户一点就发出。',
		'先看助手这一轮怎么结束的：',
		'- 在问用户、给了选项或推荐、在等确认 → 替用户简短回答。助手有推荐时多半就是同意推荐（如“好，按 A 来”“可以，提交吧”）。',
		'- 说已经做完 → 用户多半去验证、提出顺理成章的下一步，或收尾（“行，先这样”）。',
		'- 说失败、卡住、有遗留 → 让它接着处理那件具体的事。',
		'写法：',
		'- 用户本人的口吻：口语、直接，不用“请”“谢谢”“您”；照他之前消息的说话方式。',
		'- 只说一件事，越短越好，通常 4～25 个字。不要用“另外”“顺便”把几件事串在一起。',
		'- 只用对话里出现过的东西，不编造文件名、数字或细节；拿不准细节就说得概括一点。',
		'- 不重复用户已经提过的要求，不替助手说话。',
		`- 只输出这一句话，不超过 ${maxChars} 个字，不加引号和解释。`,
	].join('\n');
}

/** 助手回复去噪：记忆引用行（📎）、代码块、表格对“猜下一句”没用，还会把结尾的提问挤出预算。 */
function cleanAssistant(a) {
	let s = a.replace(/```[\s\S]*?```/g, '[代码块]');
	s = s.split('\n').filter((l) => !l.trim().startsWith('📎')).join('\n');
	s = s.replace(/(^\|.*\|[ \t]*(\n|$))+/gm, '[表格]\n');
	return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 保留开头（总结）和结尾（提问/下一步），中间省略。 */
function headTail(s, head, tail) {
	return s.length <= head + tail ? s : `${s.slice(0, head)}\n…（中间省略）…\n${s.slice(-tail)}`;
}

/** 取字符串尾部，使其 UTF-8 字节数不超过 n。 */
function tailBytes(s, n) {
	let t = s.length > n ? s.slice(-n) : s;
	let len;
	while ((len = Buffer.byteLength(t, 'utf8')) > n) t = t.slice(Math.ceil((len - n) / 3));
	return t;
}

/** 组装输入：之前几条用户消息 + 本轮用户 + 去噪后的助手回复（头尾）；超预算先丢历史，再从前面截。 */
function frame(t, maxBytes) {
	const current = [
		`[用户本轮]\n${headTail(t.user, 300, 300)}`,
		`[助手本轮回复（结尾最重要）]\n${headTail(cleanAssistant(t.assistant ?? ''), 500, 1800)}`,
	];
	const history = (t.history ?? []).length > 0
		? [`[用户之前几条消息（看口吻和目标）]\n${t.history.map((h) => `- ${h.slice(0, 150).replace(/\n/g, ' ')}`).join('\n')}`]
		: [];
	const full = [...history, ...current].join('\n\n');
	if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;
	return tailBytes(current.join('\n\n'), maxBytes);
}

/** 清洗为“一句用户口吻的话”；非空即可（“好”“嗯”这类一字真言是合法预测）。 */
function cleanSuggestion(raw, maxChars) {
	let s = String(raw ?? '');
	s = s.replace(/```[\s\S]*?```/g, ' ').trim();
	s = s.replace(/^[「『"'（(\[]+/, '').replace(/[」』"'）)\]]+$/, '').trim();
	s = s.replace(/\s+/g, ' ').trim();
	if (s.length === 0) return '';
	// 助手腔过滤：预测的应是用户说的话，不是 AI 自述
	if (/^(作为|我是|作为一个|I am|As an? |Based on)/i.test(s)) return '';
	if (/^(用户|我方|下一句|建议)[:：]/.test(s)) return '';
	if (s.length > maxChars) s = s.slice(0, maxChars);
	return s;
}

async function generate(ctx, seedConfig, session, turn) {
	const config = loadConfig(seedConfig);
	const controller = new AbortController();
	pending.set(session.id, controller);
	const deadline = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		if (config.debug) dbg('generate: enter', { session: session.id, turn, enabled: config.enabled });
		if (!config.enabled) return;
		const t = lastTurn.get(session.id);
		if (config.debug) dbg('generate: transcript', { userLen: t?.user?.length ?? 0, assistantLen: t?.assistant?.length ?? 0 });
		if (!t || !t.user) return;
		// 会话主模型命中 skipProviders（自带原生建议的会话）→ 本会话不生成
		const sessionProvider = session.requestHeader?.()?.config?.provider;
		if (sessionProvider !== undefined && config.skipProviders.includes(sessionProvider)) {
			if (config.debug) dbg(`generate: skip (session provider "${sessionProvider}" in skipProviders)`);
			return;
		}
		// 路由候选：配置的快车道优先，不可用则回退继承会话最近一次请求的路由
		const routeCandidates = [];
		if (config.provider && config.model) routeCandidates.push({ provider: config.provider, model: config.model });
		{
			const header = session.requestHeader?.()?.config;
			if (header?.provider && header?.model) routeCandidates.push({ provider: header.provider, model: header.model });
		}
		if (routeCandidates.length === 0) {
			if (!warned.has('route')) {
				warned.add('route');
				dbg('generate: NO ROUTE — set provider/model in the plugin settings, or finish one turn first');
			}
			return;
		}
		if (config.debug) dbg('generate: route candidates', routeCandidates);
		const messages = [createUserMessage({
			content: [{ type: 'text', text: frame(t, config.maxInputBytes) }],
			source: { kind: 'suggest-bar', plugin: name, form: 'transcript' },
		})];
		const drain = async (opts) => {
			const assembler = new BlockAssembler();
			for await (const chunk of ctx.llm.stream(opts)) {
				controller.signal.throwIfAborted();
				assembler.push(chunk);
			}
			const finish = assembler.finish;
			if (finish !== undefined && finish !== null && finish.kind !== 'stop') {
				const failure = finish.failure ?? {};
				const error = new Error(`generation finished with "${finish.kind}": ${String(failure.code ?? '')} ${String(failure.message ?? '')}`.trim());
				error.code = failure.code;
				throw error;
			}
			return assembler.blocks();
		};
		/** 思考档位梯子（off→low→默认，由省到费）× 路由候选回退；超时是总预算；每档带计时。 */
		const EFFORT_LADDER = ['off', 'low', undefined];
		const startedAt = Date.now();
		let blocks;
		let attemptError;
		outer:
		for (const route of routeCandidates) {
			const options = (effort) => ({
				provider: route.provider,
				model: route.model,
				messages,
				system: systemPrompt(config.maxSuggestionChars),
				// 关思考时一句话 256 足够；只能带思考的模型需给推理留余量，否则必撞 max-tokens
				maxTokens: effort === 'off' ? config.maxOutputTokens : Math.max(config.maxOutputTokens, 1024),
				sessionId: session.id,
				purpose: PURPOSE,
				...(effort !== undefined ? { reasoningEffort: effort } : {}),
				signal: controller.signal,
			});
			for (const effort of EFFORT_LADDER) {
				const t0 = Date.now();
				try {
					blocks = await drain(options(effort));
					attemptError = undefined;
					dbg(`generate: 成功 via ${route.provider}/${route.model} effort=${String(effort)} 用时${Date.now() - t0}ms 总${Date.now() - startedAt}ms`);
					break outer;
				} catch (error) {
					attemptError = error;
					if (controller.signal.aborted) break outer; // 超时/被取代：不再尝试
					if (error?.code === 'UNSUPPORTED_REASONING_EFFORT' || /max-tokens/.test(String(error?.message))) {
						if (config.debug) dbg(`generate: ${route.provider}/${route.model} effort=${String(effort)} 失败(${Date.now() - t0}ms)，降档:`, String(error?.message ?? error).slice(0, 120));
						continue; // 下一档
					}
					if (config.debug) dbg(`generate: ${route.provider}/${route.model} 不可用(${Date.now() - t0}ms)，换下一候选:`, String(error?.message ?? error).slice(0, 120));
					continue outer; // 模型不存在等硬错误：换路由
				}
			}
		}
		if (blocks === undefined && attemptError !== undefined) throw attemptError;
		const raw = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
		const text = cleanSuggestion(raw, config.maxSuggestionChars);
		if (config.debug) dbg('generate: result', { rawLen: raw.length, textLen: text.length, text: text.slice(0, 60) });
		if (text !== '') setSuggestion(session.id, { turn, text });
		else dropSuggestion(session.id);
	} catch (error) {
		dropSuggestion(session.id);
		if (!controller.signal.aborted) {
			dbg('generate: FAILED', error instanceof Error ? `${error.message}\n${String(error.stack).split('\n')[1] ?? ''}` : String(error));
		} else if (loadConfig(seedConfig).debug) {
			dbg('generate: aborted (timeout or superseded)');
		}
	} finally {
		clearTimeout(deadline);
		if (pending.get(session.id) === controller) pending.delete(session.id);
	}
}

function apply(ctx, config) {
	const dbgOn = () => loadConfig(config).debug;
	dbg('apply: mounted (config = 本插件目录 config.json，设置经 /api/suggest-bar/config 读写)');
	loadStore();
	ctx.on('session/event', (session, event) => {
		try {
			const data = event.data ?? {};
			if (event.type === 'user/message') {
				if (data.source?.kind === 'user') {
					// 实测载荷：user 消息的 blocks 在 data.content（assistant 才在 data.message.content）
					const text = textOfContent(data.content ?? data.message?.content);
					if (dbgOn()) dbg('event: user/message', { len: text.length, head: text.slice(0, 30) });
					if (text !== '') noteTurn(session.id, 'user', text);
				}
				return;
			}
			if (event.type === 'assistant/message') {
				const text = textOfContent(data.message?.content);
				if (text !== '') noteTurn(session.id, 'assistant', text);
				return;
			}
			if (event.type === 'turn/start') {
				running.set(session.id, true);
				pending.get(session.id)?.abort();
				dropSuggestion(session.id); // 用户已发话：旧建议立刻作废
				return;
			}
			if (event.type === 'turn/end') {
				running.set(session.id, false);
				if (dbgOn()) dbg('event: turn/end', { turn: data.turn, reason: data.reason?.kind });
				if (data.reason?.kind === 'completed' && typeof data.turn === 'number') {
					void generate(ctx, config, session, data.turn).catch(() => {});
				}
			}
		} catch (error) {
			dbg('event handler: FAILED', error instanceof Error ? error.message : String(error));
		}
	});
	// 建议读取路由
	ctx.effect(() => ctx.connection.fetch.register({
		path: ROUTE_PATH,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async (request) => {
			let body;
			try {
				body = await request.json();
			} catch {
				body = undefined;
			}
			const sessionId = body && typeof body === 'object' && typeof body.sessionId === 'string' && body.sessionId !== ''
				? body.sessionId
				: undefined;
			let suggestion = null;
			if (sessionId !== undefined && !running.get(sessionId)) {
				const s = store.get(sessionId);
				if (s !== undefined) suggestion = { turn: s.turn, text: s.text, label: loadConfig(config).labelText };
			}
			return Response.json({ suggestion });
		},
	}));
	// 配置读写路由：空 body=读，带字段=合并写（设置 UI 用）
	ctx.effect(() => ctx.connection.fetch.register({
		path: CONFIG_ROUTE_PATH,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async (request) => {
			let body;
			try {
				body = await request.json();
			} catch {
				body = undefined;
			}
			if (body === null || typeof body !== 'object' || body === undefined) {
				return Response.json({ config: loadConfig(config) });
			}
			const patch = {};
			if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
			if (typeof body.provider === 'string') patch.provider = body.provider;
			if (typeof body.model === 'string') patch.model = body.model;
			if (typeof body.labelText === 'string') patch.labelText = body.labelText;
			if (Array.isArray(body.skipProviders)) patch.skipProviders = body.skipProviders;
			for (const key of ['timeoutMs', 'maxOutputTokens', 'maxSuggestionChars', 'maxInputBytes']) {
				if (body[key] !== undefined) patch[key] = body[key];
			}
			if (typeof body.debug === 'boolean') patch.debug = body.debug;
			try {
				const next = Object.keys(patch).length === 0 ? loadConfig(config) : saveConfig(config, patch);
				return Response.json({ config: next });
			} catch (error) {
				return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
			}
		},
	}));
	// provider/模型目录路由（设置面板下拉用）：枚举 llm 服务的真实可用项
	ctx.effect(() => ctx.connection.fetch.register({
		path: OPTIONS_ROUTE_PATH,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async () => {
			let providers = [];
			try {
				const list = typeof ctx.llm.listProviders === 'function' ? ctx.llm.listProviders() : [];
				const ids = (Array.isArray(list) ? list : [])
					.map((p) => (typeof p === 'string' ? p : String(p?.id ?? '')))
					.filter((pid) => pid !== '');
				// listModels 是 async（各 adapter 可能联网发现模型）：并行取、每个限时 5s，
				// 一个 provider 慢或失败只让它自己的列表为空，不拖住整个下拉
				providers = await Promise.all(ids.map(async (pid) => {
					let mlist = [];
					try {
						mlist = await Promise.race([
							ctx.llm.listModels(pid),
							new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
						]);
					} catch (error) {
						dbg(`options: ${pid} 模型列表取不到:`, error instanceof Error ? error.message : String(error));
					}
					const models = (Array.isArray(mlist) ? mlist : [])
						.filter((m) => m && typeof m.id === 'string' && m.id !== '')
						.map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id }));
					return { id: pid, models };
				}));
			} catch (error) {
				dbg('options: 枚举失败:', error instanceof Error ? error.message : String(error));
			}
			return Response.json({ providers });
		},
	}));
	ctx.effect(() => () => {
		for (const controller of pending.values()) controller.abort();
		pending.clear();
		if (saveTimer !== undefined) flushStore(); // 卸载/重启前落盘未写的建议
	});
}

export { Config, apply, inject, name };
