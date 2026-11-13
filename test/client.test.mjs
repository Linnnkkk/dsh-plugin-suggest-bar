// client 侧「接线契约」测试
//
// 这一层**不渲染**：用假 react 让模块求值，验证的是 client.js 与宿主客户端之间的契约——
// 模块加载器形态、导出的 apply/inject、注册了哪些槽位、组件在什么条件下返回 null。
//
// 能守住的：宿主改了加载器或槽位约定，这里立刻红。
// 守不住的：卡片渲染、轮播、折叠、点击行为——那要真 React + DOM，本层刻意不装。
//
// 为了让「守不住」不会被误当成「测过了」：假 react 的 hooks 一旦被调用就直接抛错，
// 这样万一哪天组件体在求值阶段被意外执行，测试会响，而不是悄悄通过。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DOCK_SLOT = 'conversation.input.dock';
const SETTINGS_SLOT = 'settings.section';

// ---- 1. 以宿主加载器的形态载入 client.js ----

const loads = [];
globalThis.window = {
	__ModuleLoader__: {
		load: (entry) => { loads.push(entry); },
	},
};

// 必须在设置 window 之后再 import（client.js 在求值阶段就会调 __ModuleLoader__）
await import('../client.js');

// ---- 假 react ----

const hookTouched = (name) => () => {
	throw new Error(`组件体在求值阶段被执行了（${name}）——本层不渲染，说明测试写错了`);
};

const fakeReact = {
	useState: hookTouched('useState'),
	useEffect: hookTouched('useEffect'),
	useReducer: hookTouched('useReducer'),
	useRef: hookTouched('useRef'),
	useMemo: hookTouched('useMemo'),
	useCallback: hookTouched('useCallback'),
};

// jsx 只是把 type/props 装进对象，不会调用组件函数
const fakeJsx = {
	jsx: (type, props) => ({ type, props }),
	jsxs: (type, props) => ({ type, props }),
	Fragment: Symbol.for('react.fragment'),
};

const REQUIRED = new Set(['react', 'react/jsx-runtime']);

/** 每次调用都得到一个全新的模块实例（factory 内部状态互不干扰）。 */
function instantiate() {
	assert.equal(loads.length, 1, 'client.js 应当只调一次 __ModuleLoader__.load');
	const required = [];
	const mod = loads[0].factory((name) => {
		required.push(name);
		if (name === 'react') return fakeReact;
		if (name === 'react/jsx-runtime') return fakeJsx;
		throw new Error(`client.js 要求了未预期的模块: ${name}`);
	});
	return { mod, required };
}

/** 记录 apply 期间注册的槽位，返回 { slots, servicesInjected }。 */
function mount(mod, { services = {} } = {}) {
	const slots = [];
	const injectCalls = [];
	const ctx = {
		get: () => undefined,
		inject: (names, callback) => {
			injectCalls.push(names);
			callback(services);
		},
		slots: {
			inject: (name, callback) => callback(),
			register: (spec, component) => {
				slots.push({ spec, component });
				return () => {};
			},
		},
	};
	mod.apply(ctx);
	return { slots, injectCalls };
}

const slotNamed = (slots, name) => slots.find((s) => s.spec.name === name);

// ---- 用例 ----

test('模块以宿主的 __ModuleLoader__ 契约加载，id 与包名一致', () => {
	assert.equal(loads.length, 1);
	const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.equal(loads[0].id, pkg.name);
	assert.equal(typeof loads[0].factory, 'function');
});

test('factory 只要求 react 与 react/jsx-runtime，并导出 apply / inject', () => {
	const { mod, required } = instantiate();
	assert.deepEqual(new Set(required), REQUIRED);
	assert.equal(typeof mod.apply, 'function');
	assert.deepEqual(mod.inject, ['slots']);
});

test('apply 在输入框停靠区注册建议栏', () => {
	const { mod } = instantiate();
	const { slots } = mount(mod);
	const dock = slotNamed(slots, DOCK_SLOT);
	assert.ok(dock, `应当注册 ${DOCK_SLOT}`);
	assert.equal(dock.spec.id, 'suggest-bar');
	assert.equal(dock.spec.order, 50);
	assert.equal(typeof dock.component, 'function');
});

test('apply 在设置页注册「建议栏」一节', () => {
	const { mod } = instantiate();
	const { slots } = mount(mod);
	const section = slotNamed(slots, SETTINGS_SLOT);
	assert.ok(section, `应当注册 ${SETTINGS_SLOT}`);
	assert.equal(section.spec.id, 'suggest-bar');
	assert.equal(section.spec.order, 30);
	assert.equal(section.spec.label(), '建议栏');
});

test('建议栏在没有 sessionId 时不渲染任何东西', () => {
	const { mod } = instantiate();
	const { slots } = mount(mod);
	const dock = slotNamed(slots, DOCK_SLOT);

	assert.equal(dock.component({}), null);
	assert.equal(dock.component(undefined), null);
});

test('建议栏在有 sessionId 时把 props 透传给卡片组件', () => {
	const { mod } = instantiate();
	const { slots } = mount(mod);
	const dock = slotNamed(slots, DOCK_SLOT);

	const element = dock.component({ sessionId: 'abc', inputActions: { setDraft() {} } });
	assert.ok(element, '有 sessionId 时应当返回元素');
	assert.equal(typeof element.type, 'function');
	assert.equal(element.props.sessionId, 'abc');
});

test('设置面板组件可以被创建（不渲染）', () => {
	const { mod } = instantiate();
	const { slots } = mount(mod);
	const section = slotNamed(slots, SETTINGS_SLOT);

	const element = section.component();
	assert.ok(element);
	assert.equal(typeof element.type, 'function');
});

test('apply 会注入模型目录与会话服务', () => {
	const { mod } = instantiate();
	const { injectCalls } = mount(mod);
	assert.equal(injectCalls.length, 1);
	assert.deepEqual(injectCalls[0], ['modelDirectories', 'sessions']);
});

test('服务缺失时 apply 不抛错（优雅降级）', () => {
	const { mod } = instantiate();
	assert.doesNotThrow(() => mount(mod, { services: {} }));
});
