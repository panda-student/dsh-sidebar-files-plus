/**
 * Test harness: loads the REAL `client.js` into a `node:vm` context backed by a
 * minimal DOM, then drives the plugin's genuine handlers.
 *
 * Why a hand-rolled DOM: the workspace carries no jsdom/happy-dom, and the
 * plugin only touches a small, known slice of the DOM API. The harness
 * implements exactly that slice and nothing more, so a test failure means the
 * plugin changed behavior — not that the fixture drifted.
 *
 * Deliberate simplifications (documented so nobody trusts them further than
 * they go):
 * - `CSS.escape` is the identity function; selectors compare raw attribute
 *   values. Escaping is a browser concern, not plugin logic.
 * - No layout: `getBoundingClientRect` returns stubbed rectangles that each
 *   test may pin via `dom.setRect(element, rect)`.
 * - No CSS engine: `getComputedStyle` returns a stubbed style object.
 * - No React renderer: `useEffect` runs its body eagerly, which is exactly what
 *   the dock bridge component needs in order to register a composer.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js');

// ---------------------------------------------------------------- mini DOM --

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode !== null) node = node.parentNode;
    return this.ownerDocument?.documentElement === node;
  }
}

class FakeText extends FakeNode {
  constructor(value) {
    super(3);
    this.nodeValue = value;
  }
}

class FakeElement extends FakeNode {
  constructor(tagName, ownerDocument) {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = this.childNodes;
    this.style = {};
    this.dataset = {};
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  append(...items) {
    for (const item of items) {
      this.appendChild(typeof item === 'string' ? new FakeText(item) : item);
    }
  }
  remove() {
    if (this.parentNode === null) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index !== -1) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
  }
  contains(other) {
    for (let node = other; node !== null && node !== undefined; node = node.parentNode) {
      if (node === this) return true;
    }
    return false;
  }
  closest(selector) {
    for (let node = this; node instanceof FakeElement; node = node.parentElement) {
      if (matchesSelector(node, selector)) return node;
    }
    return null;
  }
  matches(selector) {
    return matchesSelector(this, selector);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    const found = [];
    collectElements(this, selector, found);
    return found;
  }
  getBoundingClientRect() {
    return this.rect;
  }
  addEventListener(type, handler) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  dispatchEvent(event) {
    event.target ??= this;
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) handler(event);
    return !event.defaultPrevented;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  select() {
    this.selected = true;
  }
  click() {
    this.dispatchEvent(makeEvent('click', { target: this }));
  }
}

/**
 * Selector grammar supported: descendant chains of compounds made from an
 * optional tag, `.class`, `[attr]` and `[attr="value"]`. Enough for every
 * selector the plugin and its tests use.
 */
function splitChain(selector) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of selector) {
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
    if (depth === 0 && /\s/.test(char)) {
      if (current !== '') {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current !== '') parts.push(current);
  return parts;
}

function tokenizeCompound(compound) {
  return compound.match(/\[[^\]]*\]|\.[\w-]+|[A-Za-z][\w-]*/g) ?? [];
}

function matchesCompound(element, compound) {
  for (const token of tokenizeCompound(compound)) {
    if (token.startsWith('[')) {
      const inner = token.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq === -1) {
        if (!element.hasAttribute(inner)) return false;
      } else {
        const name = inner.slice(0, eq);
        let value = inner.slice(eq + 1);
        if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
        if (element.getAttribute(name) !== value) return false;
      }
    } else if (token.startsWith('.')) {
      const classes = (element.getAttribute('class') ?? element.className ?? '').split(/\s+/);
      if (!classes.includes(token.slice(1))) return false;
    } else if (element.tagName !== token.toUpperCase()) {
      return false;
    }
  }
  return true;
}

function matchesSelector(element, selector) {
  const chain = splitChain(selector);
  if (chain.length === 0) return false;
  if (!matchesCompound(element, chain[chain.length - 1])) return false;
  let index = chain.length - 2;
  let node = element.parentElement;
  while (index >= 0) {
    if (node === null) return false;
    if (matchesCompound(node, chain[index])) index -= 1;
    node = node.parentElement;
  }
  return true;
}

function collectElements(root, selector, found) {
  for (const child of root.childNodes) {
    if (!(child instanceof FakeElement)) continue;
    if (matchesSelector(child, selector)) found.push(child);
    collectElements(child, selector, found);
  }
}

function collectTextNodes(root, found) {
  for (const child of root.childNodes) {
    if (child instanceof FakeText) found.push(child);
    else collectTextNodes(child, found);
  }
}

export function makeEvent(type, init = {}) {
  return {
    type,
    target: null,
    currentTarget: null,
    detail: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    propagationStopped: false,
    key: '',
    ...init,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
}

export function createDom() {
  // Text node -> { top, height, scroller } so `Range.getBoundingClientRect`
  // can answer with a position that responds to the scroller's scrollTop.
  const layout = new Map();
  const document = {
    activeElement: null,
    listeners: new Map(),
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    createTextNode(value) {
      return new FakeText(value);
    },
    createTreeWalker(root) {
      const nodes = [];
      collectTextNodes(root, nodes);
      let index = -1;
      return {
        nextNode() {
          index += 1;
          return nodes[index] ?? null;
        },
      };
    },
    createRange() {
      // A range's rectangle is derived from the layout the test declared, so a
      // scroll assertion can observe the effect of `scroller.scrollTop` moving.
      // `layout` maps a text node to `{ top, height }` in document space.
      return {
        startContainer: null,
        endContainer: null,
        setStart(node) {
          this.startContainer = node;
        },
        setEnd(node) {
          this.endContainer = node;
        },
        getBoundingClientRect() {
          const spec = layout.get(this.startContainer);
          if (spec === undefined) return { top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 };
          // Content above the scrollport is hidden as scrollTop grows.
          const shift = spec.scroller === undefined ? 0 : (spec.scroller.scrollTop ?? 0);
          const top = spec.top - shift;
          return { top, left: 0, right: 10, bottom: top + spec.height, width: 10, height: spec.height };
        },
      };
    },
    querySelector(selector) {
      return document.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      const found = [];
      collectElements(document.body, selector, found);
      return found;
    },
    addEventListener(type, handler) {
      const set = document.listeners.get(type) ?? new Set();
      set.add(handler);
      document.listeners.set(type, set);
    },
    removeEventListener(type, handler) {
      document.listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      event.target ??= document.body;
      for (const handler of [...(document.listeners.get(event.type) ?? [])]) handler(event);
      return !event.defaultPrevented;
    },
  };
  document.documentElement = new FakeElement('html', document);
  document.head = new FakeElement('head', document);
  document.body = new FakeElement('body', document);
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);
  document.activeElement = document.body;

  const computed = new Map();
  const selection = {
    ranges: [],
    addRangeCalls: 0,
    removeAllRangesCalls: 0,
    addRange(range) {
      this.addRangeCalls += 1;
      this.ranges.push(range);
    },
    removeAllRanges() {
      this.removeAllRangesCalls += 1;
      this.ranges.length = 0;
    },
  };

  const storage = new Map();
  const localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
    removeItem: key => {
      storage.delete(key);
    },
  };

  return {
    document,
    selection,
    storage,
    localStorage,
    notifications: [],
    highlights: new Map(),
    openCalls: [],
    mutationObservers: [],
    resizeObservers: [],
    /**
     * Declare where a text node sits and which element scrolls it.
     * @param node - the text node a range will be built on.
     * @param spec - `{ top, height, scroller }`; `top` is in document space.
     */
    setLayout(node, spec) {
      layout.set(node, spec);
    },
    setRect(element, rect) {
      const full = { top: 0, left: 0, width: 0, height: 0, ...rect };
      full.right = full.left + full.width;
      full.bottom = full.top + full.height;
      element.rect = full;
    },
    setStyle(element, style) {
      computed.set(element, style);
    },
    getComputedStyle(element) {
      return {
        overflowY: 'auto',
        position: 'static',
        display: 'block',
        visibility: 'visible',
        ...(computed.get(element) ?? {}),
      };
    },
  };
}

// ------------------------------------------------------------ plugin loader --

/**
 * Load the real plugin and run its `apply()`.
 * @param options - `{ dom }` to reuse a prepared DOM.
 * @returns the plugin's runtime pieces plus test helpers.
 */
export function loadPlugin(options = {}) {
  const dom = options.dom ?? createDom();
  const code = readFileSync(PLUGIN, 'utf8');

  let factory;
  const window = {
    innerWidth: 1200,
    innerHeight: 800,
    localStorage: dom.localStorage,
    listeners: new Map(),
    addEventListener(type, handler) {
      const set = window.listeners.get(type) ?? new Set();
      set.add(handler);
      window.listeners.set(type, set);
    },
    removeEventListener(type, handler) {
      window.listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      for (const handler of [...(window.listeners.get(event.type) ?? [])]) handler(event);
    },
    getSelection: () => dom.selection,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  };
  // The host injects the loader before the module script runs.
  window.__ModuleLoader__ = {
    load(config) {
      factory = config.factory;
    },
  };

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      dom.mutationObservers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    fire() {
      if (!this.disconnected) this.callback([]);
    }
  }

  class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      this.disconnected = false;
      dom.resizeObservers.push(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
      this.disconnected = true;
    }
    fire() {
      if (!this.disconnected) this.callback([]);
    }
  }

  class Highlight {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  }

  const CSS = {
    escape: value => String(value),
    highlights: {
      set: (name, highlight) => dom.highlights.set(name, highlight),
      delete: name => dom.highlights.delete(name),
      get: name => dom.highlights.get(name),
      has: name => dom.highlights.has(name),
    },
  };

  const sandbox = {
    window,
    document: dom.document,
    Element: FakeElement,
    Node: FakeNode,
    Text: FakeText,
    NodeFilter: { SHOW_TEXT: 4 },
    CSS,
    Highlight,
    MutationObserver,
    ResizeObserver,
    getComputedStyle: element => dom.getComputedStyle(element),
    navigator: { clipboard: { writeText: async () => {} } },
    console: { log() {}, warn() {}, error: (...args) => console.error(...args) },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  const context = createContext(sandbox);
  runInContext(code, context, { filename: PLUGIN });
  if (factory === undefined) throw new Error('plugin did not register a module factory');

  const reactCleanups = [];
  const React = {
    useEffect(effect) {
      const cleanup = effect();
      if (typeof cleanup === 'function') reactCleanups.push(cleanup);
      return cleanup;
    },
    useCallback: fn => fn,
    // Enough of createElement for the icon binding: calling a component is what
    // the real renderer does, so `type` is invoked when it is a function.
    createElement: (type, props) => (typeof type === 'function' ? type(props ?? {}) : { type, props }),
  };

  const modules = new Map([
    ['react', React],
    ['react/jsx-runtime', { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }],
    // The plugin pulls one icon out of the official primitives package. Stand
    // in a marked component so a test can prove the menu binds a real icon
    // rather than a bare label.
    ['@deepseek-ai/dsh-client-ui-primitives', {
      IconSendOutlineRegular: (props) => ({ icon: 'IconSendOutlineRegular', props }),
    }],
  ]);
  const api = factory((id) => {
    if (!modules.has(id)) throw new Error(`unexpected require("${id}")`);
    return modules.get(id);
  });

  // ---------------------------------------------------------- fake context --
  const teardowns = [];
  const dictionaries = { zh: {}, en: {} };
  const menus = [];
  const slots = { registrations: [], dock: undefined, icons: new Map() };
  const sessions = { byId: {}, scopes: new Map() };
  const remote = { canOpen: true, openOk: true };

  const ctx = {
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') teardowns.push(cleanup);
      return cleanup;
    },
    locale: {
      register(ns, entries) {
        dictionaries.zh = entries.zh;
        dictionaries.en = entries.en;
      },
      bind() {
        return (key, params) => {
          const template = dictionaries.zh[key] ?? key;
          if (params === undefined) return template;
          return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
        };
      },
    },
    slots: {
      inject(name, callback) {
        callback();
      },
      register(config, component) {
        slots.registrations.push({ ...config, component, slotName: config.name });
        if (config.name === 'conversation.input.dock') slots.dock = { config, component };
        if (config.name === 'contextMenu.icon') slots.icons.set(config.key, component);
        return { dispose() {} };
      },
    },
    contextMenus: {
      register(config) {
        menus.push(config);
        return { dispose() {} };
      },
      notify(message, ok) {
        dom.notifications.push({ message, ok });
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: sessions.byId }) },
      scope(sessionId) {
        return sessions.scopes.get(sessionId);
      },
    },
    remote: {
      session: {
        async canOpenWorkspacePath() {
          return { ok: true, value: remote.canOpen };
        },
        async openWorkspacePath(request) {
          dom.openCalls.push(request);
          return remote.openOk ? { ok: true } : { ok: false };
        },
      },
    },
  };

  api.apply(ctx);

  const plugin = {
    api,
    ctx,
    dom,
    window,
    React,
    menus,
    slots,
    sessions,
    remote,
    dictionaries,
    /** Register a composer the way the mounted dock component would. */
    mountComposer(sessionId, inputActions) {
      slots.dock.component({ sessionId, inputActions });
    },
    /** Menu entry for a target family and plugin id, as the host would resolve it. */
    menu(id, target) {
      const registration = menus.find(entry => entry.id === id && entry.target === target);
      if (registration === undefined) throw new Error(`no menu "${id}" for "${target}"`);
      return registration;
    },
    teardown() {
      for (const cleanup of teardowns) cleanup();
      for (const cleanup of reactCleanups) cleanup();
    },
  };
  return plugin;
}

/** Build the row skeleton the plugin queries: body > navigator > rows. */
export function buildNavigator(dom, { paneId = 'pane-1', root = '/ws', rows = [] } = {}) {
  const { document } = dom;
  const body = document.createElement('div');
  body.setAttribute('data-files-body', '');
  const nav = document.createElement('div');
  nav.setAttribute('data-files-navigator', paneId);
  nav.setAttribute('data-files-root', root);
  body.appendChild(nav);
  document.body.appendChild(body);
  const elements = new Map();
  for (const row of rows) {
    const element = document.createElement('div');
    element.setAttribute('data-files-path', row.path);
    element.setAttribute('data-files-entry', row.kind ?? 'file');
    element.appendChild(document.createElement('button'));
    nav.appendChild(element);
    elements.set(row.path, element);
  }
  return { body, nav, elements };
}

/** Build a visible preview frame the find bar can anchor to. */
export function buildPreview(dom, rect = { top: 100, left: 300, width: 600, height: 400 }) {
  const frame = dom.document.createElement('div');
  frame.setAttribute('data-textpreview-content', '');
  dom.setRect(frame, rect);
  dom.document.body.appendChild(frame);
  return frame;
}

/**
 * Build the code renderer's real shape inside a preview frame: the content row
 * holds a `[data-code-block-content]` viewport, and that viewport is what
 * scrolls. Text lines hang off it as text nodes, each with a declared layout so
 * range rectangles move when the viewport scrolls.
 * @returns the scrollport, for scroll assertions.
 */
export function buildCodePreview(dom, lines, { top = 100, left = 300, width = 600, height = 400 } = {}) {
  const frame = buildPreview(dom, { top, left, width, height });
  const scroller = dom.document.createElement('div');
  scroller.setAttribute('data-code-block-content', '');
  dom.setRect(scroller, { top, left, width, height });
  scroller.clientHeight = height;
  // Each line is 20px tall, so total content height follows the line count.
  scroller.scrollHeight = lines.length * 20;
  frame.appendChild(scroller);
  for (const [index, line] of lines.entries()) {
    const row = dom.document.createElement('div');
    row.className = 'line';
    const node = dom.document.createTextNode(line);
    row.appendChild(node);
    scroller.appendChild(row);
    dom.setLayout(node, { top: top + index * 20, height: 20, scroller });
  }
  return scroller;
}

/** Build the plain-text renderer's shape: the body itself scrolls. */
export function buildTextPreview(dom, lines, { top = 100, left = 300, width = 600, height = 400 } = {}) {
  const frame = buildPreview(dom, { top, left, width, height });
  const body = dom.document.createElement('div');
  body.setAttribute('data-textpreview-body', '');
  dom.setRect(body, { top, left, width, height });
  body.clientHeight = height;
  body.scrollHeight = lines.length * 20;
  frame.appendChild(body);
  for (const [index, line] of lines.entries()) {
    const row = dom.document.createElement('div');
    const node = dom.document.createTextNode(line);
    row.appendChild(node);
    body.appendChild(row);
    dom.setLayout(node, { top: top + index * 20, height: 20, scroller: body });
  }
  return body;
}

/** Append preview text so the find bar has something to search. */
export function addPreviewText(dom, frame, text) {
  const node = dom.document.createTextNode(text);
  frame.appendChild(node);
  dom.setLayout(node, { top: frame.rect.top, height: 20 });
  return node;
}

/**
 * Dispatch an event on a specific element (listeners attached to it fire).
 * Use this for handlers the plugin binds to the element itself, such as the
 * find input's Enter/Escape handling — a document-level dispatch would not
 * reach them, in the browser or here.
 */
export function fireOn(element, type, init = {}) {
  const event = makeEvent(type, { target: element, ...init });
  element.dispatchEvent(event);
  return event;
}

/**
 * Dispatch a document-level event exactly as the plugin's listeners see it.
 * @returns the event object, so a test can inspect `defaultPrevented`,
 * `propagationStopped` and any payload the plugin attached.
 */
export function fire(dom, type, init) {
  const event = makeEvent(type, init);
  dom.document.dispatchEvent(event);
  return event;
}

/** Let queued microtasks and timers settle. */
export function settle(ms = 0) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** The find bar element, or null when it has not been built yet. */
export function findBar(dom) {
  return dom.document.querySelector('[data-files-plus-find]');
}

/** Open the find bar the way a user does: Ctrl+F with a preview visible. */
export function openFind(dom) {
  fire(dom, 'keydown', { key: 'f', ctrlKey: true });
  return findBar(dom);
}

/** The find bar's text input. */
export function findInput(dom) {
  const bar = findBar(dom);
  return bar === null ? null : bar.querySelector('.fsp-term');
}

/**
 * Press one of the match toggles by its visible label (`Aa`, `ab`, `.*`).
 * Opens the bar first when needed: the toggles only exist while it is up, and
 * a test that pins a switch before searching is still a legitimate user path.
 */
export function toggleOption(dom, label) {
  if (findBar(dom) === null) openFind(dom);
  const bar = findBar(dom);
  const button = (bar?.querySelectorAll('button') ?? []).find(entry => entry.textContent === label);
  if (button === undefined) throw new Error(`no find toggle "${label}"`);
  button.click();
  return button;
}

/** Type into the find box and wait for the debounce to fire. */
export async function typeTerm(dom, term, { wait = 220 } = {}) {
  const input = findInput(dom);
  if (input === null) throw new Error('find bar is not open');
  input.value = term;
  input.dispatchEvent(makeEvent('input', { target: input }));
  await settle(wait);
  return input;
}

/** The highlighted ranges currently painted by the find bar. */
export function highlightedText(dom) {
  const highlight = dom.highlights.get('files-plus-find');
  if (highlight === undefined) return [];
  return highlight.ranges.map((range) => {
    const text = range.startContainer?.nodeValue ?? '';
    return text;
  });
}

/** The count label, e.g. `2/7` or the localized "no matches" word. */
export function countLabel(dom) {
  const bar = findBar(dom);
  return bar === null ? null : bar.querySelector('.fsp-count')?.textContent ?? null;
}

export { FakeElement, FakeText, FakeNode };
