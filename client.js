/**
 * dsh-plugin-suggest-bar（browser 半边）v0.4.0
 *
 * 「建议」栏 + 设置面板（均为两段式交互模式）：
 *   栏：conversation.input.dock 槽流式布局（框架管定位，紧贴输入框上沿，
 *       底角方形半径 = “戴帽”观感）；主题 CSS 变量自动适配明暗；
 *       打字折叠/清空展开（0.35s 过渡）；标签由 host 配置动态下发（默认“建议”）。
 *   设置面板：settings.section 槽（设置页独立一节），
 *       经 /api/suggest-bar/config 读写（自管 config.json，改完下一回合生效）。
 * 模块格式与注册姿势对齐本机 dsh-plugin-memory-view（require("react") 可用）。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-suggest-bar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");

		const ROUTE = "/api/suggest-bar";
		const CONFIG_ROUTE = "/api/suggest-bar/config";
		const OPTIONS_ROUTE = "/api/suggest-bar/options";
		const POLL_MS = 700;
		const STYLE_ID = "dsh-suggest-bar-style";
		const inject = ["slots"];

		function el(tag, props) {
			const kids = Array.prototype.slice.call(arguments, 2).filter(Boolean);
			const p = props || {};
			if (kids.length === 0) return jsxRuntime.jsx(tag, p);
			if (kids.length === 1) return jsxRuntime.jsx(tag, Object.assign({}, p, { children: kids[0] }));
			return jsxRuntime.jsxs(tag, Object.assign({}, p, { children: kids }));
		}

		// —— 视觉：宿主主题变量优先（自动适配明暗），缺省回落陶土色 ——
		const CSS = ""
			// 宽度比输入框略窄：以 DSH 核心 InputBar 的规则为基准（两侧留 side-clearance、最大 card-max-width、居中），
			// 再每边内缩核心的 dock-inset（默认 8px）；三个变量都由核心定义，手机/嵌入态核心自行调小
			+ ".dsh-suggest-card{width:calc(100% - 2 * var(--dsh-composer-side-clearance, 0px) - 2 * var(--dsh-composer-dock-inset, 8px));"
			+ "max-width:calc(var(--dsh-composer-card-max-width, 100%) - 2 * var(--dsh-composer-dock-inset, 8px));margin-left:auto;margin-right:auto;"
			+ "box-sizing:border-box;background:var(--dsw-specific-tip, var(--dsw-alias-bg-base, rgba(255,255,255,.8)));"
			+ "border:0.5px solid var(--dsw-alias-border-l1, rgba(217,119,87,.4));border-radius:12px 12px 0 0;"
			+ "padding:8px 10px;font-size:13px;max-height:240px;overflow:hidden;color:inherit;"
			+ "transition:max-height .35s ease, opacity .35s ease, padding .35s ease, border-width .35s ease;}"
			+ ".dsh-suggest-card[data-folded]{border-width:0;max-height:0;opacity:0;padding:0 10px;pointer-events:none;}"
			+ ".dsh-suggest-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}"
			+ ".dsh-suggest-icon{flex:none;display:inline-flex;color:var(--dsw-alias-accent, #c96442);}"
			+ ".dsh-suggest-label{flex:none;font-weight:600;font-size:12px;color:var(--dsw-alias-accent, #c96442);}"
			// 换一条：沿用 .dsh-suggest-btn 的视觉，只让计数等宽避免切换时抖动
			+ ".dsh-suggest-cycle{font-variant-numeric:tabular-nums;white-space:nowrap;}"
			+ ".dsh-suggest-text{flex:1 1 14em;min-width:0;overflow-wrap:break-word;}"
			+ ".dsh-suggest-actions{display:flex;align-items:center;gap:8px;margin-left:auto;}"
			+ ".dsh-suggest-btn{border:none;border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px;font-weight:500;"
			+ "background:rgba(127,127,127,.12);color:inherit;transition:background .12s ease;}"
			+ ".dsh-suggest-btn:hover{background:rgba(127,127,127,.22);}"
			+ ".dsh-suggest-btn.primary{background:#d97757;color:#fff;}"
			+ ".dsh-suggest-btn.primary:hover{background:#c4643f;}"
			+ ".dsh-suggest-x{background:none;border:none;padding:2px 6px;cursor:pointer;color:inherit;opacity:.45;font-size:13px;line-height:1;}"
			+ ".dsh-suggest-x:hover{opacity:.9;}"
			// —— 设置面板 ——
			+ ".dsh-sb-card{display:flex;flex-direction:column;gap:10px;padding:6px 0 10px;font-size:13px;}"
			+ ".dsh-sb-desc{opacity:.65;font-size:12.5px;}"
			+ ".dsh-sb-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}"
			+ ".dsh-sb-row>label:first-child{flex:0 0 150px;opacity:.85;}"
			+ ".dsh-sb-input{flex:1 1 220px;min-width:0;border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));"
			+ "border-radius:8px;padding:5px 10px;background:transparent;color:inherit;font-size:13px;}"
			+ ".dsh-sb-input:focus{outline:none;border-color:var(--dsw-alias-accent, #c96442);}"
			+ ".dsh-sb-check{width:16px;height:16px;accent-color:#d97757;cursor:pointer;}"
			+ ".dsh-sb-hint{opacity:.6;font-size:12px;}"
			+ ".dsh-sb-saved{font-size:12px;color:#3a9a5c;opacity:0;transition:opacity .2s;}"
			+ ".dsh-sb-saved[data-on]{opacity:1;}"
			+ ".dsh-sb-pick{display:flex;align-items:center;gap:6px;flex:1 1 220px;min-width:0;}"
			+ ".dsh-sb-pick .dsh-sb-input{flex:1 1 auto;}"
			+ ".dsh-sb-manual{flex:none;border:none;background:none;cursor:pointer;font-size:13px;opacity:.5;padding:2px 4px;}"
			+ ".dsh-sb-manual:hover{opacity:1;}"
			+ ".dsh-sb-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1 1 220px;}"
			+ ".dsh-sb-chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 6px 2px 10px;"
			+ "background:rgba(127,127,127,.14);font-size:12px;}"
			+ ".dsh-sb-chip-x{border:none;background:none;cursor:pointer;color:inherit;opacity:.5;padding:0 2px;font-size:11px;}"
			+ ".dsh-sb-chip-x:hover{opacity:1;}"
			+ ".dsh-sb-chip-add{border:1px dashed rgba(127,127,127,.4);border-radius:999px;background:transparent;"
			+ "color:inherit;font-size:12px;padding:2px 8px;cursor:pointer;}";

		let styleUsers = 0;
		function ensureStyle() {
			if (styleUsers === 1 && document.getElementById(STYLE_ID) === null) {
				const tag = document.createElement("style");
				tag.id = STYLE_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
		}
		function useStyle() {
			react.useEffect(() => {
				styleUsers += 1;
				ensureStyle();
				return () => {
					styleUsers -= 1;
					if (styleUsers === 0) {
						const tag = document.getElementById(STYLE_ID);
						if (tag !== null) tag.remove();
					}
				};
			}, []);
		}

		let rootCtx = null;
		function shellOf(sessionId) {
			const conversation = rootCtx && typeof rootCtx.get === "function" ? rootCtx.get("conversation") : undefined;
			const input = conversation && conversation.input ? conversation.input : undefined;
			return input && typeof input.shell === "function" ? input.shell(sessionId) : undefined;
		}

		/** 轮询 hook：每 700ms 读一次 host；失败一律按“无建议”处理，绝不打扰输入框。 */
		function useSuggestion(sessionId) {
			const [state, setState] = react.useState(null);
			react.useEffect(() => {
				let cancelled = false;
				let pending = false;
				const controller = new AbortController();
				const read = () => {
					if (pending) return;
					pending = true;
					fetch(ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId }),
						signal: controller.signal,
					})
						.then((r) => r.json())
						.then((body) => {
							if (cancelled) return;
							const sug = body && typeof body === "object" ? body.suggestion : null;
							const s = sug && typeof sug === "object"
								&& Array.isArray(sug.texts) && sug.texts.length > 0
								&& sug.texts.every((t) => typeof t === "string" && t.trim() !== "")
								&& Number.isInteger(sug.turn) ? sug : null;
							setState((prev) => {
								if (prev === null && s === null) return prev;
								if (prev !== null && s !== null && prev.turn === s.turn
									&& prev.texts.length === s.texts.length
									&& prev.texts.every((t, i) => t === s.texts[i])) return prev;
								return s;
							});
						})
						.catch(() => {})
						.finally(() => { pending = false; });
				};
				read();
				const timer = setInterval(read, POLL_MS);
				return () => {
					cancelled = true;
					controller.abort();
					clearInterval(timer);
				};
			}, [sessionId]);
			return state;
		}

		/** 草稿感知：优先订阅 composer shell 状态（无订阅面则 300ms 兜底轮询）。 */
		function useDraft(sessionId) {
			const [draft, setDraft] = react.useState("");
			react.useEffect(() => {
				const shell = shellOf(sessionId);
				if (shell === undefined || shell.state === undefined || shell.state === null) return;
				const read = () => {
					try { setDraft(String(shell.state.getSnapshot()?.draft ?? "")); }
					catch { /* 保持原值 */ }
				};
				read();
				if (typeof shell.state.subscribe === "function") {
					let un;
					try { un = shell.state.subscribe(read); } catch { un = undefined; }
					if (typeof un === "function") return () => { try { un(); } catch { } };
				}
				const timer = setInterval(read, 300);
				return () => clearInterval(timer);
			}, [sessionId]);
			return draft;
		}

		/** 用用户身份发送：setDraft 走 Lexical 异步更新，必须等草稿真落定再 submit（对齐 dsh-suggest-actions 实证）。 */
		function sendAsUser(sessionId, text) {
			const shell = shellOf(sessionId);
			const actions = shell && shell.actions ? shell.actions : undefined;
			const setDraft = actions && typeof actions.setDraft === "function" ? (v) => actions.setDraft(v)
				: (shell && typeof shell.setDraft === "function" ? (v) => shell.setDraft(v) : undefined);
			if (setDraft === undefined) return;
			setDraft(text);
			const submit = actions && typeof actions.submit === "function" ? () => actions.submit() : undefined;
			if (submit === undefined) return; // 至少已填入草稿
			let tries = 0;
			const settle = () => {
				let d;
				try { d = shell.state && typeof shell.state.getSnapshot === "function" ? shell.state.getSnapshot().draft : undefined; }
				catch { d = undefined; }
				if (d === text || tries++ > 40) { submit(); return; }
				setTimeout(settle, 25);
			};
			settle();
		}

		const SPARK = el("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": true },
			el("path", { d: "M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" }));

		/** 建议卡本体（主题变量 + 底角方半径 + 折叠动画）。 */
		function SuggestCard({ text, label, folded, onUse, onSend, onDismiss, index, total, onCycle }) {
			return el("div", {
				className: "dsh-suggest-card",
				"data-folded": folded ? "" : undefined,
				role: "status",
				"aria-hidden": folded ? true : undefined,
			},
				el("div", { className: "dsh-suggest-row" },
					el("span", { className: "dsh-suggest-icon" }, SPARK),
					el("span", { className: "dsh-suggest-label" }, label),
					el("span", { className: "dsh-suggest-text" }, text),
					el("span", { className: "dsh-suggest-actions" },
						total > 1
							? el("button", {
								className: "dsh-suggest-btn dsh-suggest-cycle", type: "button", disabled: folded,
								title: "换一条建议", "aria-label": `换一条建议（第 ${index + 1} 条，共 ${total} 条）`,
								onClick: onCycle,
							}, `${index + 1}/${total}`)
							: null,
						el("button", { className: "dsh-suggest-btn primary", type: "button", disabled: folded, onClick: onUse }, "采用"),
						el("button", { className: "dsh-suggest-btn", type: "button", disabled: folded, onClick: onSend }, "发送"),
						el("button", { className: "dsh-suggest-x", type: "button", "aria-label": "关闭建议", title: "关闭", disabled: folded, onClick: onDismiss }, "✕"),
					),
				),
			);
		}

		/** dock 槽组件：framework 管布局；建议存在才挂载，打字/已关闭时折叠（不卸载，保住动画）。 */
		function SuggestBarDock({ sessionId, inputActions }) {
			const suggestion = useSuggestion(sessionId);
			const draft = useDraft(sessionId);
			const [dismissedTurn, setDismissedTurn] = react.useState(-1);
			const [pick, setPick] = react.useState(0);
			const texts = suggestion !== null && Array.isArray(suggestion.texts) ? suggestion.texts : [];
			const stamp = suggestion !== null ? `${suggestion.turn}:${texts.join("|")}` : "";
			// 新一批建议到达 → 回到第一条
			react.useEffect(() => { setPick(0); }, [stamp]);
			useStyle();
			if (suggestion === null || sessionId === undefined || texts.length === 0) return null;
			const folded = draft.trim() !== "" || suggestion.turn === dismissedTurn;
			const label = typeof suggestion.label === "string" && suggestion.label !== "" ? suggestion.label : "建议";
			const index = Math.min(pick, texts.length - 1);
			const current = texts[index];
			const adopt = () => {
				if (inputActions && typeof inputActions.setDraft === "function") inputActions.setDraft(current);
			};
			const send = () => sendAsUser(sessionId, current);
			const close = () => setDismissedTurn(suggestion.turn);
			const cycle = () => setPick((prev) => (prev + 1) % texts.length);
			return el(SuggestCard, {
				text: current, label, folded, onUse: adopt, onSend: send, onDismiss: close,
				index, total: texts.length, onCycle: cycle,
			});
		}

		// ================= 设置面板（settings.section 槽 + 自有配置路由） =================

		/** 配置读写 hook：POST 空体=读，POST 字段=合并写；写后 1.2s 显示“已保存”。 */
		function usePluginConfig() {
			const [cfg, setCfg] = react.useState(null);
			const [savedOn, setSavedOn] = react.useState(false);
			const savedTimer = react.useRef(undefined);
			const read = react.useCallback(() => {
				fetch(CONFIG_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })
					.then((r) => r.json())
					.then((b) => { if (b && typeof b === "object" && b.config) setCfg(b.config); })
					.catch(() => {});
			}, []);
			react.useEffect(() => { read(); }, [read]);
			const update = react.useCallback((patch) => {
				setCfg((prev) => (prev === null ? prev : Object.assign({}, prev, patch)));
				fetch(CONFIG_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) })
					.then((r) => r.json())
					.then((b) => {
						if (b && typeof b === "object" && b.config) setCfg(b.config);
						setSavedOn(true);
						if (savedTimer.current !== undefined) clearTimeout(savedTimer.current);
						savedTimer.current = setTimeout(() => setSavedOn(false), 1200);
					})
					.catch(() => { read(); });
			}, [read]);
			return { cfg, update, savedOn };
		}

		function Field({ label, hint, children }) {
			return el("div", { className: "dsh-sb-row" },
				el("label", null, label),
				children,
				hint ? el("span", { className: "dsh-sb-hint" }, hint) : null,
			);
		}

		/** 文本字段：本地草稿 + 失焦/回车提交（避免每键一写）；list=true 时提交为数组。 */
		function TextField({ label, hint, field, cfg, update, list, placeholder }) {
			const raw = cfg === null ? "" : cfg[field];
			const value = list ? (Array.isArray(raw) ? raw.join(", ") : "") : String(raw ?? "");
			const [text, setText] = react.useState(value);
			react.useEffect(() => { setText(value); }, [value]);
			const commit = () => {
				if (list) {
					const arr = text.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
					if (arr.join(",") !== (Array.isArray(raw) ? raw.join(",") : "")) update({ [field]: arr });
					return;
				}
				const v = text.trim();
				if (v !== value) update({ [field]: v });
			};
			return el(Field, { label, hint },
				el("input", { className: "dsh-sb-input", type: "text", value: text, placeholder,
					onChange: (e) => setText(e.target.value),
					onBlur: commit,
					onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } } }));
		}

		function CheckField({ label, hint, field, cfg, update }) {
			const checked = cfg !== null && cfg[field] === true;
			return el(Field, { label, hint },
				el("input", { className: "dsh-sb-check", type: "checkbox", checked,
					onChange: (e) => update({ [field]: e.target.checked }) }));
		}

		function NumberField({ label, hint, field, cfg, update, min }) {
			const value = cfg === null ? "" : String(cfg[field] ?? "");
			return el(Field, { label, hint },
				el("input", { className: "dsh-sb-input", type: "number", min, value,
					onBlur: (e) => { const n = Math.max(min, Number(e.target.value)); if (Number.isFinite(n)) update({ [field]: n }); },
					onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } } }));
		}

		/** provider/模型目录 hook：枚举 llm 服务的真实可用项（下拉用）。 */
		function usePluginOptions() {
			const [providers, setProviders] = react.useState(null);
			react.useEffect(() => {
				let cancelled = false;
				fetch(OPTIONS_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })
					.then((r) => r.json())
					.then((b) => {
						if (cancelled) return;
						const list = b && typeof b === "object" && Array.isArray(b.providers) ? b.providers : [];
						setProviders(list.filter((p) => p && typeof p.id === "string" && p.id !== "" && Array.isArray(p.models)));
					})
					.catch(() => { if (!cancelled) setProviders([]); });
				return () => { cancelled = true; };
			}, []);
			return providers;
		}

		// 客户端模型目录服务（模型选择器同款数据源；apply 里 scoped inject 灌入）
		let modelDirSvc = null;
		let sessionsSvc = null;

		/** modelDirectories 枚举：取任一在册会话的目录 groups（真实 provider→models 映射）。服务可能晚于组件挂载就绪：500ms 重试。 */
		function useModelDirectory() {
			const [groups, setGroups] = react.useState(null);
			react.useEffect(() => {
				let cancelled = false;
				let tries = 0;
				let timer;
				const attempt = () => {
					if (cancelled) return;
					if (modelDirSvc === null) {
						if (tries++ < 20) timer = setTimeout(attempt, 500);
						return;
					}
					let sid;
					try {
						const byId = sessionsSvc?.list?.getSnapshot?.()?.byId;
						sid = byId ? Object.keys(byId)[0] : undefined;
					} catch { sid = undefined; }
					if (sid === undefined) {
						if (tries++ < 20) timer = setTimeout(attempt, 500);
						return;
					}
					let dir;
					try { dir = modelDirSvc.directoryFor(sid); } catch { return; }
					const pull = () => {
						try {
							const snap = dir?.store?.getSnapshot?.();
							const g = snap?.groups;
							if (Array.isArray(g) && g.length > 0 && !cancelled) {
								setGroups(g
									.filter((x) => x && typeof x.id === "string" && Array.isArray(x.models))
									.map((x) => ({
										id: x.id,
										models: x.models
											.filter((m) => m && typeof m.id === "string" && m.id !== "")
											.map((m) => ({ id: m.id, name: typeof m.name === "string" && m.name !== "" ? m.name : m.id })),
									})));
								return true;
							}
						} catch { /* 目录快照不可读 */ }
						return false;
					};
					if (!pull() && typeof dir?.load === "function") {
						dir.load?.().then(() => { if (!cancelled) pull(); }).catch(() => {});
					}
				};
				attempt();
				return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
			}, []);
			return groups;
		}

		/** 合并两个枚举源：modelDirectories（真实模型）优先，host 路由补 provider 名。 */
		function mergeProviders(hostList, dirGroups) {
			const byId = new Map();
			for (const p of hostList ?? []) byId.set(p.id, { id: p.id, models: new Map(p.models.map((m) => [m.id, m])) });
			for (const g of dirGroups ?? []) {
				const entry = byId.get(g.id) ?? { id: g.id, models: new Map() };
				for (const m of g.models) if (!entry.models.has(m.id)) entry.models.set(m.id, m);
				byId.set(g.id, entry);
			}
			return [...byId.values()].map((p) => ({ id: p.id, models: [...p.models.values()] }));
		}

		/** 下拉字段：空值 = 占位项（如“跟随会话路由”）。 */
		function SelectField({ label, hint, value, placeholder, options, disabled, onChange }) {
			const opts = options.slice();
			if (value !== "" && !opts.some((o) => o.value === value)) {
				opts.push({ value, label: `${value}（不在目录）` }); // 手动设过但目录没有：保留可见
			}
			return el(Field, { label, hint },
				el("select", { className: "dsh-sb-input", value, disabled, onChange: (e) => onChange(e.target.value) },
					el("option", { value: "", key: "__empty__" }, placeholder),
					opts.map((o) => el("option", { value: o.value, key: o.value }, o.label)),
				));
		}

		/** 下拉+手动双模式字段：✎ 切到手动输入（可填目录外的值），▾ 切回下拉。 */
		function PickField({ label, hint, value, options, placeholder, disabled, onChange }) {
			const [manual, setManual] = react.useState(false);
			const [text, setText] = react.useState(value);
			react.useEffect(() => { setText(value); }, [value]);
			if (manual) {
				const commit = () => {
					const v = text.trim();
					setManual(false);
					if (v !== value) onChange(v);
				};
				return el(Field, { label, hint },
					el("span", { className: "dsh-sb-pick" },
						el("input", { className: "dsh-sb-input", type: "text", value: text, placeholder,
							onChange: (e) => setText(e.target.value),
							onBlur: commit,
							onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } } }),
						el("button", { className: "dsh-sb-manual", type: "button", title: "切回下拉", onClick: () => setManual(false) }, "▾")));
			}
			const opts = options.slice();
			if (value !== "" && !opts.some((o) => o.value === value)) opts.push({ value, label: `${value}（不在目录）` });
			return el(Field, { label, hint },
				el("span", { className: "dsh-sb-pick" },
					el("select", { className: "dsh-sb-input", value, disabled, onChange: (e) => onChange(e.target.value) },
						el("option", { value: "", key: "__empty__" }, placeholder),
						opts.map((o) => el("option", { value: o.value, key: o.value }, o.label))),
					el("button", { className: "dsh-sb-manual", type: "button", title: "手动输入", onClick: () => setManual(true) }, "✎")));
		}

		/** 跳过的 provider：标签芯片（✕ 移除）＋「＋ 添加」下拉（选项来自枚举）。 */
		function SkipField({ label, hint, cfg, update, providerOptions }) {
			const list = Array.isArray(cfg.skipProviders) ? cfg.skipProviders : [];
			const available = providerOptions.filter((o) => !list.includes(o.value));
			return el(Field, { label, hint },
				el("span", { className: "dsh-sb-chips" },
					list.map((p) => el("span", { className: "dsh-sb-chip", key: p }, p,
						el("button", { className: "dsh-sb-chip-x", type: "button", "aria-label": `移除 ${p}`,
							onClick: () => update({ skipProviders: list.filter((x) => x !== p) }) }, "✕"))),
					available.length > 0 ? el("select", { className: "dsh-sb-chip-add", value: "", key: "add",
						onChange: (e) => { const v = e.target.value; if (v !== "" && !list.includes(v)) update({ skipProviders: [...list, v] }); } },
						el("option", { value: "" }, "＋ 添加…"),
						available.map((o) => el("option", { value: o.value, key: o.value }, o.label))) : null,
					list.length === 0 && available.length === 0 ? el("span", { className: "dsh-sb-hint" }, "（目录未就绪，稍候刷新设置页）") : null));
		}

		/** 设置节组件：自取配置（不依赖任何传入 props）。 */
		function SuggestBarSettings() {
			const { cfg, update, savedOn } = usePluginConfig();
			const hostProviders = usePluginOptions();
			const dirGroups = useModelDirectory();
			useStyle();
			if (cfg === null) {
				return el("div", { className: "dsh-sb-card" }, el("span", { className: "dsh-sb-hint" }, "加载配置中…"));
			}
			const providerList = mergeProviders(hostProviders, dirGroups);
			const modelsOf = (pid) => (providerList.find((p) => p.id === pid)?.models ?? []);
			const providerOptions = providerList.map((p) => ({ value: p.id, label: p.id }));
			const modelOptions = modelsOf(cfg.provider).map((m) => ({ value: m.id, label: m.name !== m.id ? `${m.name}（${m.id}）` : m.id }));
			const onProviderChange = (v) => {
				const patch = { provider: v };
				if (v === "" || !modelsOf(v).some((m) => m.id === cfg.model)) patch.model = "";
				update(patch);
			};
			return el("div", { className: "dsh-sb-card" },
				el("div", { className: "dsh-sb-desc" }, "回合结束后，输入框上方预测你的下一句（异步小调用；点“采用”填入输入框，“发送”直接发出）。改动下一回合生效。"),
				el(CheckField, { label: "启用", field: "enabled", cfg, update }),
				el(SelectField, {
					label: "生成时机",
					hint: "「每次都生成」不看也备好；「仅对话在前台时」切走就不生成，回来自动补一次",
					value: cfg.generateMode ?? "always",
					placeholder: "每次都生成",
					options: [
						{ value: "always", label: "每次都生成" },
						{ value: "when-active", label: "仅对话在前台时" },
					],
					onChange: (v) => update({ generateMode: v }),
				}),
				el(TextField, { label: "标签文案", hint: "建议栏左侧标签", field: "labelText", cfg, update }),
				el(PickField, {
					label: "生成 provider",
					hint: providerList.length === 0 ? "目录加载中…（✎ 可手动输入）" : "留空 = 跟随会话路由",
					value: cfg.provider, placeholder: "跟随会话路由",
					options: providerOptions, onChange: onProviderChange,
				}),
				el(PickField, {
					label: "生成模型",
					hint: cfg.provider === "" ? "先选 provider" : "建议选快模型（如 deepseek-flash / haiku）",
					value: cfg.model, placeholder: "跟随会话路由",
					options: modelOptions, onChange: (v) => update({ model: v }),
				}),
				el(SkipField, {
					label: "跳过的 provider",
					hint: "这些 provider 的会话不生成建议",
					cfg, update, providerOptions,
				}),
				el(NumberField, { label: "总超时(ms)", field: "timeoutMs", cfg, update, min: 1000 }),
				el(NumberField, { label: "输出 token 上限", field: "maxOutputTokens", cfg, update, min: 16 }),
				el(NumberField, { label: "建议最大字符数", field: "maxSuggestionChars", cfg, update, min: 10 }),
				el(CheckField, { label: "调试日志", hint: "全链路写 ~/dsh.log", field: "debug", cfg, update }),
				el("div", { className: "dsh-sb-row" },
					el("span", { className: "dsh-sb-saved", "data-on": savedOn ? "" : undefined }, "✓ 已保存")),
			);
		}

		function apply(ctx) {
			rootCtx = ctx;
			// 客户端模型目录服务（provider/模型下拉的真实数据源；不可用时优雅降级到 host 路由枚举）
			ctx.inject(["modelDirectories", "sessions"], (mctx) => {
				try { modelDirSvc = mctx.modelDirectories; } catch { modelDirSvc = null; }
				try { sessionsSvc = mctx.sessions; } catch { sessionsSvc = null; }
			});
			// 建议栏：composer 停靠区，流式布局（紧贴输入框上沿）
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "suggest-bar",
				order: 50,
			}, (props) => (props && props.sessionId ? el(SuggestBarDock, props) : null)));
			// 设置面板：设置页独立一节（settings.section 槽位）
			ctx.slots.inject("settings.section", () => (
				ctx.slots.register({
					name: "settings.section",
					id: "suggest-bar",
					order: 30,
					label: () => "建议栏",
					inject: () => ({}),
				}, () => el(SuggestBarSettings)), null));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
