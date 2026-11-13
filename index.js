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
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';

const name = 'dsh-plugin-suggest-bar';
const ROUTE_PATH = '/api/suggest-bar';
const CONFIG_ROUTE_PATH = '/api/suggest-bar/config';
const OPTIONS_ROUTE_PATH = '/api/suggest-bar/options';
const EFFORT_TEST_ROUTE_PATH = '/api/suggest-bar/test-effort';
const STATS_ROUTE_PATH = '/api/suggest-bar/stats';
const PURPOSE = 'suggest-bar';
// 数据目录默认就是插件目录本身。测试用 SUGGEST_BAR_DATA_DIR 指向临时目录，
// 否则会读到真实的 config.json / suggestions.json，甚至把它们写坏。
const DATA_DIR = process.env.SUGGEST_BAR_DATA_DIR ?? fileURLToPath(new URL('.', import.meta.url));
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const STORE_PATH = join(DATA_DIR, 'suggestions.json');
const DEBUG_PATH = join(DATA_DIR, 'debug.log');
const DEBUG_PREV_PATH = join(DATA_DIR, 'debug.log.1');
const FEEDBACK_PATH = join(DATA_DIR, 'feedback.jsonl');
const FEEDBACK_MAX_LINES = 500; // 只留最近 N 次评估，够看趋势又不至于无限长
const DEBUG_MAX_BYTES = 2 * 1024 * 1024; // 超过就重开，避免无界增长
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
	/** 一次最多给几条候选。是上限不是配额：凑不出这么多不同方向就少给。 */
	maxSuggestions: z.natural().min(1).max(6).default(3),
	maxInputBytes: z.natural().min(512).default(10240),
	/** 生成时机：always=每回合都生成；when-active=只有该对话在前台时才生成（省 token）。 */
	generateMode: z.string().default('always'),
	/** 思考档位：auto=自动探测；off / low=固定；none=不传该字段。设置面板「测试」会自动写入。 */
	effort: z.string().default('auto'),
	/** 助手回复里以这些前缀开头的行在拼输入前丢掉（如记忆引用标记）；默认空=不丢任何行。 */
	stripLinePrefixes: z.array(z.string()).default([]),
	debug: z.boolean().default(false),
});

/** 内存注册表（随 host 进程存活）。 */
const store = new Map();    // sessionId -> { turn: number, text: string }
const running = new Map();  // sessionId -> boolean
const pending = new Map();  // sessionId -> AbortController
const lastTurn = new Map(); // sessionId -> { user: string, assistant: string }
/** 本轮最后一次工具调用的成败：给模型看"实际发生了什么"，而不只是助手自己怎么说。 */
const lastStep = new Map(); // sessionId -> { name: string, ok: boolean|undefined }
const callNames = new Map(); // callId -> { sessionId, name }（tool/result 只带 toolCallId，靠它回查；带 sessionId 才能只清本会话）
const generatedTurn = new Map(); // sessionId -> turn（同一回合只生成一次，防重复调用）
/** 待评估的建议副本：turn/start 会作废 store 里的显示副本，但评估要用到它。 */
const pendingEval = new Map(); // sessionId -> { turn, texts }
const warned = new Set();
/** when-active 模式：前端最近一次轮询时间（有轮询=有人正在看这个对话）。 */
const lastPoll = new Map();   // sessionId -> timestamp
/** when-active 模式下"没人在看"错过的回合，等用户回到对话时补生成一次。 */
const deferred = new Map();   // sessionId -> { session, turn }
const ACTIVE_WINDOW_MS = 15000; // 15s 内有轮询就算在看（轮询间隔 700ms，留足容错）
const isActive = (sessionId) => {
	const at = lastPoll.get(sessionId);
	return at !== undefined && Date.now() - at < ACTIVE_WINDOW_MS;
};

/** 建议持久化：独立 suggestions.json（不写会话日志），host 重启后恢复；写盘 500ms 防抖。 */
function loadStore() {
	try {
		const data = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
		for (const [id, s] of Object.entries(data ?? {})) {
			if (!s || !Number.isInteger(s.turn)) continue;
			// 兼容旧格式（单条 text）与新格式（texts 数组）
			const texts = Array.isArray(s.texts)
				? s.texts.filter((t) => typeof t === 'string' && t !== '')
				: (typeof s.text === 'string' && s.text !== '' ? [s.text] : []);
			if (texts.length > 0) store.set(id, { turn: s.turn, texts });
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
	// 留一份待评估副本：turn/start 会先把 store 里的作废掉（实测顺序是 start → user/message），
	// 那份副本必须活到用户真正发出下一条消息，否则永远评估不到。
	pendingEval.set(sessionId, { turn: value.turn, texts: value.texts });
	while (pendingEval.size > STORE_MAX) pendingEval.delete(pendingEval.keys().next().value);
	saveStoreSoon();
}
function dropSuggestion(sessionId) {
	if (store.delete(sessionId)) saveStoreSoon();
}

// ---------- 命中率统计（本地，只落本机文件，不上报） ----------

/** 把「建议 vs 用户实际发出的下一句」比对一次，追加一行。 */
function recordFeedback(rec) {
	try {
		appendFileSync(FEEDBACK_PATH, `${JSON.stringify(rec)}\n`, 'utf8');
		const lines = readFileSync(FEEDBACK_PATH, 'utf8').split('\n').filter((l) => l !== '');
		if (lines.length > FEEDBACK_MAX_LINES) {
			writeFileSync(FEEDBACK_PATH, `${lines.slice(-FEEDBACK_MAX_LINES).join('\n')}\n`, 'utf8');
		}
	} catch (error) {
		dbg('feedback: 落盘失败:', error instanceof Error ? error.message : String(error));
	}
}

/**
 * 用户真正发话时评估上一条建议。
 * exact=一模一样；prefix=采用后改过（一方是另一方前缀）；miss=没用。
 */
function evaluateSuggestion(sessionId, actualText) {
	const pending = pendingEval.get(sessionId);
	pendingEval.delete(sessionId);
	if (pending === undefined || pending.texts.length === 0 || actualText === '') return;
	let match = 'miss';
	let index = -1;
	const norm = (s) => s.trim();
	const actual = norm(actualText);
	for (let i = 0; i < pending.texts.length; i += 1) {
		const t = norm(pending.texts[i]);
		if (t === '') continue;
		if (t === actual) { match = 'exact'; index = i; break; }
		if (match !== 'prefix' && (actual.startsWith(t) || t.startsWith(actual))) { match = 'prefix'; index = i; }
	}
	recordFeedback({
		at: new Date().toISOString(),
		turn: pending.turn,
		match,
		index,
		// 只留长度与极短摘要，避免把整段对话写进统计文件
		actualLen: actual.length,
		actualHead: actual.slice(0, 40),
		texts: pending.texts.map((t) => t.slice(0, 60)),
	});
}

/** 读 feedback.jsonl 汇总。按条数、按命中类型、按第几条命中。 */
function feedbackStats(limit = FEEDBACK_MAX_LINES) {
	let records = [];
	try {
		records = readFileSync(FEEDBACK_PATH, 'utf8')
			.split('\n').filter((l) => l !== '')
			.slice(-limit)
			.map((l) => { try { return JSON.parse(l); } catch { return null; } })
			.filter((r) => r !== null && typeof r.match === 'string');
	} catch { /* 还没产生过反馈 */ }
	const total = records.length;
	const exact = records.filter((r) => r.match === 'exact').length;
	const prefix = records.filter((r) => r.match === 'prefix').length;
	const byIndex = [0, 0, 0];
	for (const r of records) {
		if (typeof r.index === 'number' && r.index >= 0 && r.index < byIndex.length) byIndex[r.index] += 1;
	}
	const pct = (n) => (total === 0 ? null : Math.round((n / total) * 1000) / 10);
	return {
		total,
		exact,
		prefix,
		miss: total - exact - prefix,
		exactRate: pct(exact),
		usefulRate: pct(exact + prefix),
		byIndex,
	};
}

/** 直写 stdout（dsh.log）的调试探针——不依赖 ctx.logger（实测 warn 不落盘）。 */
/** debug 开关的镜像，由 loadConfig 每次刷新——dbg 只在开启时落盘。 */
let debugEnabled = false;
/** 调试探针：stdout + 插件目录 debug.log（DSH 的 stdout 走 supervisord pipe，读不到）。 */
const dbg = (...args) => {
	if (!debugEnabled) return; // 关掉就彻底安静：stdout 和文件都不写
	console.log('[suggest-bar]', ...args);
	try {
		if (statSync(DEBUG_PATH).size > DEBUG_MAX_BYTES) {
			// 真轮转：当前 → debug.log.1（覆盖上一份），再新建一份空的。
			// 以前是直接清空，历史会无声消失。
			try { renameSync(DEBUG_PATH, DEBUG_PREV_PATH); } catch { /* 目标被占用等情况：退化为清空 */ }
			writeFileSync(DEBUG_PATH, '', 'utf8');
		}
	} catch { /* 文件还不存在 */ }
	try {
		appendFileSync(DEBUG_PATH, `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`, 'utf8');
	} catch { /* 写不动就算了，调试不影响主流程 */ }
};

/** 任意来源（yml / config.json / 路由 patch）→ 规整后的有效配置。 */
/** 数字钳制：非数字回退默认值，数字则钳到 [lo, hi]。 */
function clampInt(v, fallback, lo, hi) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(hi, Math.max(lo, Math.floor(n)));
}

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
		maxOutputTokens: numOr(c?.maxOutputTokens, 512, 16),
		maxSuggestionChars: numOr(c?.maxSuggestionChars, 120, 10),
		// 超出范围直接钳到 1..6（而不是回退默认），这样用户填 0 或 99 都能看到边界值
		maxSuggestions: clampInt(c?.maxSuggestions, 3, 1, 6),
		maxInputBytes: numOr(c?.maxInputBytes, 10240, 512),
		generateMode: c?.generateMode === 'when-active' ? 'when-active' : 'always',
		effort: ['off', 'low', 'none'].includes(c?.effort) ? c.effort : 'auto',
		stripLinePrefixes: Array.isArray(c?.stripLinePrefixes)
			? c.stripLinePrefixes.filter((x) => typeof x === 'string' && x !== '')
			: [],
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
		debugEnabled = configCache.debug === true;
		return configCache;
	} catch {
		const initial = resolveConfig(seed);
		try {
			writeFileSync(CONFIG_PATH, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
			configCache = initial;
			configMtime = statSync(CONFIG_PATH).mtimeMs;
			debugEnabled = initial.debug === true;
			dbg('config: 首启落盘', CONFIG_PATH);
		} catch (error) {
			configCache = initial;
			debugEnabled = initial.debug === true;
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
		t.history = [...t.history, t.user].slice(-2); // 之前几条用户消息：只学口吻，80 字/条够用
		t.assistant = ''; // 新一轮开始，上一轮的助手回复作废
	}
	t[key] = text;
	lastTurn.set(sessionId, t);
}

/**
 * v2 提示词（2026-11-12 在 72 条真实会话样本上评测选出）：
 * 现行版爱出“好”“谢谢整理”这类空话；只加细节的版本又太长、爱把几件事串起来、编造细节。
 */
function systemPrompt(count) {
	return [
		'你替用户预写他下一条要发的消息——本质是给助手下的一条指令，不是对上一句的回应。',
		'每条都必须让助手去做一件具体的事：改哪个、查什么、跑什么、接着做哪一步、或解释什么。没有动作对象的话不要说（纯态度、纯评价、纯确认都不算）。',
		'需要用户亲自动手的事（重启、点按钮、改文件），他要么做完才回（下一条带结果），要么直接说别的，不会回「好，我重启一下」。',
		'只说用户真会发的：指令、纠正、要求下一步、追问、解释/诊断；状态汇报、观察、猜测、评价不写。',
		'口吻照抄他最近几条：口语、直接、短，十个字能说完不用二十个。',
		'助手让他选 → 写那个选项；助手做完 → 下一步做什么；助手卡住/有遗留 → 让它接着处理那件事。不替助手说话，不用「另外」「顺便」串多句。',
		`最多输出 ${count} 行，每行一条，各覆盖一个不同方向（同意/纠正/追问/换思路/补充约束等），可能性从高到低；凑不出这么多不同方向就少给，不要换说法凑数；无序号、引号、Markdown、解释。`,
		'都没把握就只输出 NONE。',
	].join('\n');
}

/** 助手回复去噪：引用标记行（由配置指定）、代码块、表格对“猜下一句”没用，还会把结尾的提问挤出预算。 */
function cleanAssistant(a, stripPrefixes) {
	let s = a.replace(/```[\s\S]*?```/g, '[代码块]');
	if (stripPrefixes.length > 0) {
		s = s.split('\n').filter((l) => {
			const t = l.trim();
			return !stripPrefixes.some((p) => t.startsWith(p));
		}).join('\n');
	}
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

/** 组装输入：之前几条用户消息 + 本轮用户 + 去噪后的助手回复（头尾）+ 最后一步的真实成败。超预算先丢历史，再从前面截。 */
function frame(t, maxBytes, stripPrefixes = [], step) {
	const current = [
		`[用户本轮]\n${headTail(t.user, 300, 300)}`,
		`[助手本轮回复（结尾最重要）]\n${headTail(cleanAssistant(t.assistant ?? '', stripPrefixes), 500, 1800)}`,
	];
	// 助手多半以"我做完了"收尾（实测 89%），但真正决定用户下一句是"修一下"还是"继续"的，
	// 是那一步到底成没成。这一行约 30 token，是输入里性价比最高的一段。
	if (step !== undefined && typeof step.name === 'string' && step.name !== '') {
		const outcome = step.ok === true ? '成功' : (step.ok === false ? '失败' : '未回报');
		current.push(`[本轮最后一步] ${step.name} → ${outcome}`);
	}
	const history = (t.history ?? []).length > 0
		? [`[用户之前几条消息（学口吻，也看他习惯怎么下指令）]\n${t.history.map((h) => `- ${h.slice(0, 80).replace(/\n/g, ' ')}`).join('\n')}`]
		: [];
	const full = [...history, ...current].join('\n\n');
	if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;
	return tailBytes(current.join('\n\n'), maxBytes);
}

/** 清洗为“一句用户口吻的话”；非空即可（“好”“嗯”这类一字真言是合法预测）。 */
/** 按行解析模型输出：一行一条，最多 3 条；NONE / 助手腔 / markdown 行一律丢弃。 */
function cleanSuggestions(raw, maxChars, maxCount) {
	const out = [];
	const lines = String(raw ?? '').replace(/```[\s\S]*?```/g, '\n').split(/\r?\n/);
	for (const line of lines) {
		let t = line.trim();
		if (t === '') continue;
		// 去序号、列表符号、包裹引号（提示词要求不要，这里兜底）
		t = t.replace(/^[-*+•]\s+/, '').replace(/^\d+[.、)]\s*/, '');
		t = t.replace(/^[「『"'（(\[]+/, '').replace(/[」』"'）)\]]+$/, '').trim();
		if (t === '') continue;
		if (/^NONE$/i.test(t)) continue; // 单独一行 NONE = 没把握，不出建议
		// 模型不听话时的兜底：纯确认词、以及复述助手让用户做的动作（"好，我重启一下"）
		if (/^(好的?|行|嗯+|哦+|收到|明白|了解|ok)[\s，,。！!、~]*$/i.test(t)) continue;
		// 只拦带第一人称的复述（"好，我重启一下"）；"行，那改吧"这种是批准，有信息，保留
		// 必须出现第一人称/即时标记，避免误杀「行，改吧」这类批准
		if (/^(好的?|行|嗯+|ok)[\s，,。！!、]*(我|这就|马上|现在)[\s，,。！!、]*(先|去|来|这就|马上)?[\s，,。！!、]*(重启|试试|试一下|试一试|看看|看下|弄|改|打开|点一下|发|跑|查|验证|确认|收尾)/i.test(t)) continue;
		if (/^\|.*\|$/.test(t) || /^#{1,6}\s/.test(t)) continue; // 表格 / 标题
		// 助手腔：预测的应是用户说的话
		if (/^(作为|我是|作为一个|I am|As an? |Based on)/i.test(t)) continue;
		if (/^(用户|我方|下一句|建议|让我|我来|下面|以下|根据上述|总结)[:：]?/.test(t) && t.length > 12) continue;
		if (t.length > maxChars) t = t.slice(0, maxChars);
		out.push(t);
		if (out.length >= maxCount) break;
	}
	return out;
}

/**
 * 某个 provider/model 该按什么顺序试思考档位。
 * 优先问 DSH 这个模型支持哪些档（assets from least to greatest），直接取最省的一档，不必试错；
 * 查不到能力信息就不传该字段；查询失败再退回 EFFORT_LADDER。
 * 结果按 provider/model 缓存，避免每次生成都去查（可能是联网查询）。
 */
const EFFORT_CACHE_MAX = 64;
const EFFORT_CACHE_TTL_MS = 10 * 60 * 1000;
const effortCache = new Map(); // `${provider}/${model}` -> { at, ladder }
async function ladderFor(ctx, provider, model, fallback) {
	const key = `${provider}/${model}`;
	const hit = effortCache.get(key);
	if (hit !== undefined && Date.now() - hit.at < EFFORT_CACHE_TTL_MS) {
		effortCache.delete(key);
		effortCache.set(key, hit); // 保持 LRU 顺序
		return hit.ladder;
	}
	let ladder;
	try {
		const info = await ctx.llm.resolveModelInfo(provider, model, AbortSignal.timeout(3000));
		const efforts = info?.reasoning?.efforts;
		if (Array.isArray(efforts) && efforts.length > 0) {
			ladder = [efforts[0].id]; // 已按由省到费排序
		} else {
			ladder = [undefined]; // 该模型没有可选思考档：不传这个字段
		}
	} catch (error) {
		dbg('effort: 能力查询失败，退回梯子:', error instanceof Error ? error.message : String(error));
		return fallback; // 不缓存失败，下次再试
	}
	effortCache.delete(key);
	effortCache.set(key, { at: Date.now(), ladder });
	while (effortCache.size > EFFORT_CACHE_MAX) effortCache.delete(effortCache.keys().next().value);
	return ladder;
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
		const step = lastStep.get(session.id);
		const frameText = frame(t, config.maxInputBytes, config.stripLinePrefixes, step);
		if (config.debug) {
			// 只记"输入由哪几段组成"和工具名/成败，不记正文——够定位问题，又不把对话写进日志
			dbg('generate: input', {
				bytes: Buffer.byteLength(frameText, 'utf8'),
				sections: frameText.split('\n').filter((l) => l.startsWith('[')).map((l) => l.slice(0, 24)),
				step: step === undefined ? null : { name: step.name, ok: step.ok },
			});
		}
		const messages = [createUserMessage({
			content: [{ type: 'text', text: frameText }],
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
		/** 思考档位梯子（兜底用）：off 最省 → low → 不传（模型默认）。 */
		const EFFORT_LADDER = ['off', 'low', undefined];
		const startedAt = Date.now();
		let blocks;
		let attemptError;
		outer:
		for (const route of routeCandidates) {
			// 设置里测过就用它（零开销）；否则问这个模型支持哪些档（带缓存）；再不行退回梯子
			const ladder = config.effort === 'auto'
				? await ladderFor(ctx, route.provider, route.model, EFFORT_LADDER)
				: [config.effort === 'none' ? undefined : config.effort];
			const options = (effort) => ({
				provider: route.provider,
				model: route.model,
				messages,
				system: systemPrompt(config.maxSuggestions),
				// 关思考时一句话 256 足够；只能带思考的模型需给推理留余量，否则必撞 max-tokens
				// 上限必须放得下 N 条：否则条数一调大，最后一条会被静默截掉
				maxTokens: Math.max(
					effort === 'off' ? config.maxOutputTokens : Math.max(config.maxOutputTokens, 1024),
					Math.ceil(config.maxSuggestions * config.maxSuggestionChars * 1.2),
				),
				sessionId: session.id,
				purpose: PURPOSE,
				...(effort !== undefined ? { reasoningEffort: effort } : {}),
				signal: controller.signal,
			});
			for (const effort of ladder) {
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
		// 多行解析：必须按换行保留边界，不能用空格拼接
		const raw = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
		const texts = cleanSuggestions(raw, config.maxSuggestionChars, config.maxSuggestions);
		if (config.debug) dbg('generate: result', { rawLen: raw.length, count: texts.length, texts: texts.map((t) => t.slice(0, 40)) });
		if (texts.length > 0) setSuggestion(session.id, { turn, texts });
		else { dropSuggestion(session.id); pendingEval.delete(session.id); }
	} catch (error) {
		dropSuggestion(session.id);
		pendingEval.delete(session.id);
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
	loadConfig(config); // 先读一次，让 debug 开关在第一条日志前生效
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
					if (text !== '') {
						// 用户真发了话 → 上一条建议是否命中，在这里结算
						evaluateSuggestion(session.id, text);
						noteTurn(session.id, 'user', text);
					}
				}
				return;
			}
			if (event.type === 'assistant/message') {
				const text = textOfContent(data.message?.content);
				if (text !== '') noteTurn(session.id, 'assistant', text);
				return;
			}
			// 工具调用：记下「本轮最后一步做了什么、成没成」。助手 89% 以陈述收尾，
			// 但用户下一句是"修一下"还是"继续"，取决于这一步的真实结果。
			if (event.type === 'tool/call') {
				const toolName = typeof data.name === 'string' ? data.name : '';
				if (toolName !== '') {
					lastStep.set(session.id, { name: toolName, ok: undefined });
					if (typeof data.callId === 'string') {
						callNames.set(data.callId, { sessionId: session.id, name: toolName });
						while (callNames.size > 200) callNames.delete(callNames.keys().next().value);
					}
				}
				return;
			}
			if (event.type === 'tool/result') {
				const failed = data.message?.isError === true;
				const callId = data.message?.toolCallId;
				const knownEntry = typeof callId === 'string' ? callNames.get(callId) : undefined;
				const known = knownEntry === undefined ? undefined : knownEntry.name;
				if (typeof callId === 'string') callNames.delete(callId);
				const step = lastStep.get(session.id);
				const toolName = known ?? step?.name;
				if (typeof toolName === 'string' && toolName !== '') {
					lastStep.set(session.id, { name: toolName, ok: !failed });
				}
				return;
			}
			if (event.type === 'turn/start') {
				running.set(session.id, true);
				pending.get(session.id)?.abort();
				deferred.delete(session.id); // 用户已发话：欠账作废
				dropSuggestion(session.id); // 用户已发话：旧建议立刻作废（待评估副本保留）
				lastStep.delete(session.id); // 新一轮，上一步的结论作废
				// 只清本会话的在途调用：并发会话（如子任务）不该被别人的 turn/start 牵连
				for (const [cid, entry] of callNames) { if (entry.sessionId === session.id) callNames.delete(cid); }
				return;
			}
			if (event.type === 'turn/end') {
				running.set(session.id, false);
				if (dbgOn()) dbg('event: turn/end', { turn: data.turn, reason: data.reason?.kind });
				if (data.reason?.kind === 'completed' && typeof data.turn === 'number') {
					// 同一回合只生成一次：重复的 turn/end 不该再花一次 token
					if (generatedTurn.get(session.id) === data.turn) {
						if (dbgOn()) dbg('event: turn/end 该回合已生成过，跳过', { turn: data.turn });
						return;
					}
					generatedTurn.set(session.id, data.turn);
					if (dbgOn() && loadConfig(config).generateMode === 'when-active') {
						dbg('event: turn/end 模式判定', { turn: data.turn, active: isActive(session.id) });
					}
					if (loadConfig(config).generateMode === 'when-active' && !isActive(session.id)) {
						// 没人在看：记一笔欠账，等前端回到这个对话时再生成
						deferred.delete(session.id);
						deferred.set(session.id, { session, turn: data.turn });
						while (deferred.size > STORE_MAX) deferred.delete(deferred.keys().next().value);
						return;
					}
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
			if (sessionId !== undefined) {
				// 有轮询 = 有人正在看这个对话（when-active 模式的判定依据）
				lastPoll.delete(sessionId);
				lastPoll.set(sessionId, Date.now());
				while (lastPoll.size > STORE_MAX) lastPoll.delete(lastPoll.keys().next().value);
				const debt = deferred.get(sessionId);
				if (debt !== undefined && !running.get(sessionId)) {
					// 用户回到这个对话：把错过的那个回合补生成一次
					deferred.delete(sessionId);
					void generate(ctx, config, debt.session, debt.turn).catch(() => {});
				}
			}
			let suggestion = null;
			if (sessionId !== undefined && !running.get(sessionId)) {
				const s = store.get(sessionId);
				if (s !== undefined) suggestion = { turn: s.turn, texts: s.texts, label: loadConfig(config).labelText };
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
			if (Array.isArray(body.stripLinePrefixes)) patch.stripLinePrefixes = body.stripLinePrefixes.filter((x) => typeof x === 'string' && x !== '');
			for (const key of ['timeoutMs', 'maxOutputTokens', 'maxSuggestionChars', 'maxSuggestions', 'maxInputBytes']) {
				if (body[key] !== undefined) patch[key] = body[key];
			}
			if (body.generateMode === 'always' || body.generateMode === 'when-active') patch.generateMode = body.generateMode;
			if (['auto', 'off', 'low', 'none'].includes(body.effort)) patch.effort = body.effort;
			if (typeof body.debug === 'boolean') patch.debug = body.debug;
			try {
				const next = Object.keys(patch).length === 0 ? loadConfig(config) : saveConfig(config, patch);
				return Response.json({ config: next });
			} catch (error) {
				return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
			}
		},
	}));
	// 思考档位测试：真发一个最小请求，依次试 off → low → 不传，第一个成功的即该模型可用档位
	ctx.effect(() => ctx.connection.fetch.register({
		path: EFFORT_TEST_ROUTE_PATH,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async (request) => {
			let body;
			try {
				body = await request.json();
			} catch {
				body = undefined;
			}
			const cfg = loadConfig(config);
			const provider = typeof body?.provider === 'string' && body.provider !== '' ? body.provider : cfg.provider;
			const model = typeof body?.model === 'string' && body.model !== '' ? body.model : cfg.model;
			if (!provider || !model) return Response.json({ ok: false, error: '先在设置里选好 provider 和模型' }, { status: 400 });
			const tried = [];
			let lastError;
			for (const effort of ['off', 'low', undefined]) {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 20000);
				try {
					const stream = ctx.llm.stream({
						provider, model,
						messages: [createUserMessage({
							content: [{ type: 'text', text: '回复：OK' }],
							source: { kind: 'suggest-bar', plugin: name, form: 'effort-test' },
						})],
						maxTokens: 8,
						...(effort !== undefined ? { reasoningEffort: effort } : {}),
						purpose: PURPOSE,
						signal: controller.signal,
					});
					const assembler = new BlockAssembler();
					for await (const chunk of stream) assembler.push(chunk);
					clearTimeout(timer);
					const finish = assembler.finish;
					if (finish.kind !== 'stop' && finish.kind !== 'max-tokens' && finish.kind !== 'tool-calls') {
						const failure = finish.failure ?? {};
						throw new Error(`generation finished with "${finish.kind}": ${String(failure.code ?? '')} ${String(failure.message ?? '')}`.trim());
					}
					dbg('effort test: 成功档位', effort ?? 'none');
					return Response.json({ ok: true, effort: effort ?? 'none', tried: [...tried, effort ?? 'none'] });
				} catch (error) {
					clearTimeout(timer);
					lastError = error;
					tried.push(effort ?? 'none');
					if (controller.signal.aborted) break;
				}
			}
			dbg('effort test: 全部失败', tried);
			return Response.json({ ok: false, error: lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown'), tried }, { status: 500 });
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
	// 命中率统计路由：建议准不准，用真实"用户下一句"结算，只读本机文件
	ctx.effect(() => ctx.connection.fetch.register({
		path: STATS_ROUTE_PATH,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async () => Response.json({ stats: feedbackStats() }),
	}));
	ctx.effect(() => () => {
		for (const controller of pending.values()) controller.abort();
		pending.clear();
		deferred.clear();
		lastPoll.clear();
		effortCache.clear();
		lastStep.clear();
		callNames.clear();
		generatedTurn.clear();
		pendingEval.clear();
		if (saveTimer !== undefined) flushStore(); // 卸载/重启前落盘未写的建议
	});
}

export { Config, apply, inject, name };
