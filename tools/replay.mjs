#!/usr/bin/env node
// 离线回放评测：把真实历史会话按事件喂给插件本身，用插件自己的输入拼装、本地选项、
// 解析与命中结算跑一遍，得到与线上 feedback.jsonl 同口径的命中率。
//
// 数据源：Claude Code 会话记录（~/.claude/projects/<当前目录编码>/*.jsonl）。
// 三段式：
//   1. 收集：回放一遍，模型调用全部记下、先回 NONE
//   2. 补缓存：只对缓存里没有的请求真调模型（并发），结果按「模型+系统提示+输入」哈希落盘
//   3. 结算：再回放一遍，模型回复全部取自缓存，插件自己结算命中
// 同一批样本、同一份提示词重跑不花 token；改了提示词/输入拼装，只有变了的请求会重新调用。
//
// 用法：
//   node tools/replay.mjs --base <Anthropic Messages 接口地址> [--model <模型>] [--src <会话目录>]
//                         [--since 2026-11-01] [--last 300] [--concurrency 6] [--set key=value] [--offline]
//   --base     模型接口（必填，除非 --offline），密钥取环境变量 SUGGEST_BAR_REPLAY_KEY
//   --model    缺省取插件 config.json 里的 model
//   --src      缺省 ~/.claude/projects/<当前工作目录，非字母数字替换成 -> （Claude Code 的命名规则）
//   --offline  只用缓存，缺的当 NONE（零 token，用于改了统计口径后重算）
// 插件配置（条数、去噪前缀、思考档位等）取插件自己的 config.json，回放与线上一致。
//
// 数据（会话片段、模型回复缓存、明细）只写本机 replay-data/，已在 .gitignore 里。

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'replay-data');
const CACHE_PATH = join(OUT_DIR, 'cache.jsonl');

// ---------- 参数 ----------

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
// 插件的真实配置：回放要与线上同参数（必须在下面把数据目录改到临时目录之前读）
const REAL_CONFIG_PATH = join(process.env.SUGGEST_BAR_DATA_DIR ?? ROOT, 'config.json');
let realConfig = {};
try { realConfig = JSON.parse(readFileSync(REAL_CONFIG_PATH, 'utf8')); } catch { /* 没有就用插件默认 */ }
const MODEL = opt('model', typeof realConfig.model === 'string' ? realConfig.model : '');
const BASE = opt('base', '');
const SINCE = opt('since', '');
const LAST = Number(opt('last', '0'));
const CONCURRENCY = Number(opt('concurrency', '6'));
const OFFLINE = args.includes('--offline');
// --set key=value（可多次）：覆盖插件配置做对照实验，如 --set maxSuggestions=2
const OVERRIDES = {};
args.forEach((a, i) => {
	if (a !== '--set' || i + 1 >= args.length) return;
	const [k, ...v] = args[i + 1].split('=');
	const raw = v.join('=');
	OVERRIDES[k] = raw === 'true' ? true : raw === 'false' ? false : (Number.isFinite(Number(raw)) && raw !== '' ? Number(raw) : raw);
});
const SRC_DIR = opt('src', join(homedir(), '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-')));
if (MODEL === '') { console.error('缺模型：用 --model 指定，或先在插件设置里选好模型'); process.exit(2); }
if (BASE === '' && !OFFLINE) { console.error('缺模型接口：用 --base 指定（Anthropic Messages 兼容），或加 --offline 只用缓存'); process.exit(2); }
if (!existsSync(SRC_DIR)) { console.error(`会话目录不存在：${SRC_DIR}（用 --src 指定）`); process.exit(2); }

// 插件的数据目录必须在 import 之前指到临时目录：绝不碰真实的 config / suggestions / feedback
const DATA_DIR = mkdtempSync(join(tmpdir(), 'suggest-bar-replay-'));
process.env.SUGGEST_BAR_DATA_DIR = DATA_DIR;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[suggest-bar]')) return; realLog(...a); };
const { apply } = await import(join(ROOT, 'index.js'));

// ---------- 会话记录 → 插件事件 ----------

const SYSTEM_BLOCK = /^(You are|Agent Teams|Current runtime|Your working|The following|IMPORTANT|Background|background|Codebase and user|As you answer)/;
const NOT_TYPED = /^(<task-notification|<goal_round>|<dsystem>|Base directory|Background s|\[Request interrupted|<command-|<local-command|Caveat:)/;

/** 从一条 user 记录里取出用户亲手打的字；不是用户打的返回 null。 */
function typedText(raw) {
	let s = raw;
	if (s.includes('<User>')) { // 首轮包装；偶尔也夹在正文中间
		const blocks = [...s.matchAll(/<User>\n?([\s\S]*?)\n?<\/User>/g)].map((m) => m[1].trim());
		const mine = blocks.filter((b) => b !== '' && !SYSTEM_BLOCK.test(b));
		if (mine.length === 0) return null;
		s = mine[mine.length - 1];
	}
	s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
	s = s.replace(/\n*Time sampled while preparing[\s\S]*$/, '');
	s = s.split('\n').filter((l) => !/^\[Image: /.test(l.trim())).join('\n').trim();
	if (s === '' || NOT_TYPED.test(s)) return null;
	return s;
}

function contentText(content) {
	if (typeof content === 'string') return { text: content, toolResults: [] };
	if (!Array.isArray(content)) return { text: '', toolResults: [] };
	const toolResults = content.filter((b) => b && b.type === 'tool_result');
	const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
	return { text, toolResults };
}

/** 一个会话文件 → { id, start, events: [{ ev, real }] }；real=该 user/message 是用户亲手打的。 */
async function loadSession(file) {
	const events = [];
	let turn = 0;
	let open = false; // 当前回合是否已开始
	let start;
	const asst = new Map(); // message.id -> 累积文本
	const startTurn = () => {
		if (open) events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
		turn += 1;
		open = true;
		events.push({ type: 'turn/start', data: { turn } });
	};
	// 逐行读：单个会话记录可能超过 500MB（内嵌图片），整读会超出字符串上限
	for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
		if (line === '' || line.length > 2_000_000) continue; // 超大行几乎都是图片附件
		let o;
		try { o = JSON.parse(line); } catch { continue; }
		if (o.isSidechain) continue;
		if (start === undefined && typeof o.timestamp === 'string') start = o.timestamp;
		if (o.type === 'user') {
			const { text, toolResults } = contentText(o.message?.content);
			if (toolResults.length > 0) {
				for (const r of toolResults) {
					events.push({ type: 'tool/result', data: { message: { toolCallId: r.tool_use_id, isError: r.is_error === true } } });
				}
				continue;
			}
			if (o.isMeta) continue;
			const typed = typedText(text);
			startTurn();
			// 非用户亲手打的（后台通知等）：线上也会形成一个回合，但没有 source=user 的消息
			if (typed !== null) {
				events.push({ type: 'user/message', data: { content: [{ type: 'text', text: typed }], source: { kind: 'user' } }, at: o.timestamp });
			}
			continue;
		}
		if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
			const id = o.message.id ?? o.uuid;
			for (const b of o.message.content) {
				if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
					const joined = asst.has(id) ? `${asst.get(id)} ${b.text}` : b.text;
					asst.set(id, joined);
					events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: joined }] } } });
				} else if (b.type === 'tool_use') {
					events.push({ type: 'tool/call', data: { name: b.name, callId: b.id } });
				}
			}
		}
	}
	// 最后一个回合没有下一句可比，不结束它（也就不生成）
	return { id: file.replace(/^.*\//, '').replace(/\.jsonl$/, ''), start: start ?? '', events };
}

// ---------- 假 ctx：插件只看见这些 ----------

function makeCtx(llm) {
	const routes = new Map();
	const handlers = new Map();
	const ctx = {
		llm: {
			resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
			stream: llm,
			listProviders: () => [],
			listModels: async () => [],
		},
		on: (event, handler) => { handlers.set(event, handler); },
		effect: (fn) => { fn(); },
		connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
	};
	const post = async (path, body) => {
		const res = await routes.get(path).fetch(new Request(`http://localhost${path}`, {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
		}));
		return res.json();
	};
	return { ctx, post, emit: (session, ev) => handlers.get('session/event')(session, ev) };
}

// ---------- 模型调用与缓存 ----------

const cache = new Map();
if (existsSync(CACHE_PATH)) {
	for (const l of readFileSync(CACHE_PATH, 'utf8').split('\n')) {
		if (l === '') continue;
		try { const r = JSON.parse(l); cache.set(r.key, r.text); } catch { /* 坏行跳过 */ }
	}
}
const inputOf = (opts) => opts.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const keyOf = (opts) => createHash('sha256').update(JSON.stringify([opts.model, opts.system, inputOf(opts), opts.maxTokens, opts.reasoningEffort ?? null])).digest('hex');

async function callModel(opts) {
	const body = {
		model: opts.model,
		max_tokens: opts.maxTokens,
		system: opts.system,
		messages: [{ role: 'user', content: inputOf(opts) }],
		...(opts.reasoningEffort === 'off' ? { thinking: { type: 'disabled' } } : {}),
	};
	for (let attempt = 1; ; attempt += 1) {
		try {
			const res = await fetch(`${BASE}/v1/messages`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-api-key': process.env.SUGGEST_BAR_REPLAY_KEY ?? 'local', 'anthropic-version': '2023-06-01' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(90_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
			const json = await res.json();
			return (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
		} catch (error) {
			if (attempt >= 3) throw error;
			await new Promise((r) => setTimeout(r, 2000 * attempt));
		}
	}
}

// ---------- 一次回放 ----------

const tick = () => new Promise((r) => setImmediate(r));

let passNo = 0;
async function replay(sessions, respond) {
	// 插件的会话级状态（同一回合只生成一次、在途评估等）是模块全局的：
	// 每遍换一套会话 ID，否则第 2 遍会把第 1 遍生成过的回合全部跳过
	passNo += 1;
	let inflight = 0;
	const llm = (opts) => {
		inflight += 1;
		return (async function* () {
			try {
				const text = await respond(opts);
				yield { type: 'text-delta', index: 0, text };
				yield { type: 'finish', reason: { kind: 'stop' } };
			} finally { inflight -= 1; }
		})();
	};
	const h = makeCtx(llm);
	apply(h.ctx, { enabled: true });
	await h.post('/api/suggest-bar/config', {
		...realConfig,
		enabled: true, provider: 'eval', model: MODEL, skipProviders: [], debug: false, generateMode: 'always',
		// auto 档会去问模型能力，回放里没有真实 DSH：按最省的 off 跑
		...(realConfig.effort === undefined || realConfig.effort === 'auto' ? { effort: 'off' } : {}),
		...OVERRIDES,
	});
	writeFileSync(join(DATA_DIR, 'feedback.jsonl'), '', 'utf8'); // 每遍都从空白开始
	for (const s of sessions) {
		const session = { id: `p${passNo}-${s.id}`, requestHeader: () => ({}) };
		for (const ev of s.events) {
			h.emit(session, ev);
			if (ev.type === 'turn/end') {
				await tick();
				while (inflight > 0) await new Promise((r) => setTimeout(r, 5));
				for (let i = 0; i < 3; i += 1) await tick();
			}
		}
	}
	return readFileSync(join(DATA_DIR, 'feedback.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
}

// ---------- 主流程 ----------

const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => join(SRC_DIR, f));
let sessions = (await Promise.all(files.map(loadSession))).filter((s) => s.events.some((e) => e.type === 'turn/end'));
if (SINCE !== '') sessions = sessions.filter((s) => s.start >= SINCE);
sessions.sort((a, b) => a.start.localeCompare(b.start));
if (LAST > 0) {
	// 取最近 N 个可评估回合所在的会话
	let n = 0;
	const keep = [];
	for (let i = sessions.length - 1; i >= 0 && n < LAST; i -= 1) {
		keep.unshift(sessions[i]);
		n += sessions[i].events.filter((e) => e.type === 'user/message').length;
	}
	sessions = keep;
}
realLog(`会话 ${sessions.length} 个，用户消息 ${sessions.reduce((n, s) => n + s.events.filter((e) => e.type === 'user/message').length, 0)} 条；模型 ${MODEL}${Object.keys(OVERRIDES).length > 0 ? `；覆盖 ${JSON.stringify(OVERRIDES)}` : ''}`);

// 1. 收集
const wanted = new Map();
await replay(sessions, async (opts) => { const k = keyOf(opts); if (!cache.has(k)) wanted.set(k, opts); return cache.get(k) ?? 'NONE'; });
realLog(`需要调用模型 ${wanted.size} 次（缓存已有 ${cache.size}）${OFFLINE ? '——离线模式，跳过' : ''}`);

// 2. 补缓存
if (!OFFLINE && wanted.size > 0) {
	mkdirSync(OUT_DIR, { recursive: true });
	const queue = [...wanted.entries()];
	let done = 0;
	let failed = 0;
	await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
		while (queue.length > 0) {
			const [key, opts] = queue.shift();
			try {
				const text = await callModel(opts);
				cache.set(key, text);
				appendFileSync(CACHE_PATH, `${JSON.stringify({ key, model: opts.model, text })}\n`, 'utf8');
			} catch (error) {
				failed += 1;
				realLog('调用失败:', String(error?.message ?? error).slice(0, 160));
			}
			done += 1;
			if (done % 20 === 0) realLog(`  ${done}/${wanted.size}`);
		}
	}));
	if (failed > 0) realLog(`失败 ${failed} 次（按 NONE 处理，重跑会补）`);
}

// 3. 结算（模型原始输出另存一份，方便查「出了字却没出卡」这类问题）
const raws = [];
const records = await replay(sessions, async (opts) => {
	const text = cache.get(keyOf(opts)) ?? 'NONE';
	raws.push({ inputTail: inputOf(opts).slice(-200), raw: text });
	return text;
});
const count = (f) => records.filter(f).length;
const pct = (n, d) => (d === 0 ? '-' : `${(Math.round((n / d) * 1000) / 10)}%`);
const total = records.length;
const line = (label, rs) => {
	const hit = rs.filter((r) => r.match === 'exact' || r.match === 'prefix').length;
	const close = rs.filter((r) => r.match !== 'miss').length;
	return `${label}：${rs.length} 回合，命中（exact+prefix）${hit} = ${pct(hit, rs.length)}，含意思接近 ${close} = ${pct(close, rs.length)}`;
};
realLog('');
realLog(line('全部', records));
realLog(line('  模型', records.filter((r) => r.source === 'model')));
realLog(line('  本地选项', records.filter((r) => r.source === 'local')));
realLog(`  exact ${count((r) => r.match === 'exact')} / prefix ${count((r) => r.match === 'prefix')} / similar ${count((r) => r.match === 'similar')} / miss ${count((r) => r.match === 'miss')}；第 1/2/3 条命中 ${[0, 1, 2].map((i) => count((r) => r.index === i)).join(' / ')}`);
mkdirSync(OUT_DIR, { recursive: true });
const detail = join(OUT_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
writeFileSync(detail, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
realLog(`明细：${detail}（共 ${total} 条）`);
writeFileSync(detail.replace(/run-/, 'raw-'), raws.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
