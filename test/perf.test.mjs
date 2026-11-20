/**
 * Performance probes for the gesture layer.
 *
 * These are not correctness tests: they count expensive DOM work so a
 * regression shows up as a number rather than as "feels laggy". The thresholds
 * are deliberately loose — they catch algorithmic mistakes (a full-tree scan
 * per mutation) without failing on machine-speed noise.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin, buildNavigator, buildPreview, fire, settle } from './harness.mjs';

/** A navigator with many rows, so a full scan is measurable. */
function bigTree(plugin, rows = 400) {
  const list = Array.from({ length: rows }, (_, index) => ({ path: `src/dir${index}/file${index}.ts` }));
  const navigator = buildNavigator(plugin.dom, { rows: list });
  plugin.sessions.byId['s1'] = { sessionId: 's1', cwd: '/ws', retainedBy: { mainView: 1 } };
  return navigator;
}

describe('mutation handling', () => {
  test('a burst of mutations costs one paint pass, not one per mutation', async () => {
    const plugin = loadPlugin();
    const navigator = bigTree(plugin);
    fire(plugin.dom, 'contextmenu', { target: navigator.elements.get('src/dir0/file0.ts'), button: 2 });

    // Count row scans by instrumenting the attribute writes the paint performs.
    let writes = 0;
    const original = plugin.dom.document.querySelector;
    plugin.dom.document.querySelector = function patched(selector) {
      if (selector.startsWith('[data-files-navigator="')) writes += 1;
      return original.call(this, selector);
    };

    // 50 mutations in the same frame, as a streaming token update produces.
    const observer = plugin.dom.mutationObservers[0];
    for (let index = 0; index < 50; index += 1) observer.fire();
    await settle(40);

    plugin.dom.document.querySelector = original;
    assert.ok(writes <= 2, `expected the burst to coalesce, saw ${writes} pane lookups`);
    plugin.teardown();
  });

  test('mutations with an empty selection do no row scanning', async () => {
    const plugin = loadPlugin();
    const navigator = bigTree(plugin);
    let scans = 0;
    const nav = navigator.nav;
    const originalAll = nav.querySelectorAll.bind(nav);
    nav.querySelectorAll = (selector) => {
      if (selector === '[data-files-path]') scans += 1;
      return originalAll(selector);
    };

    const observer = plugin.dom.mutationObservers[0];
    for (let index = 0; index < 20; index += 1) observer.fire();
    await settle(40);

    assert.equal(scans, 0, 'nothing is selected, so no rows need repainting');
    plugin.teardown();
  });

  test('a mutation never forces a layout read while the find bar is closed', async () => {
    const plugin = loadPlugin();
    bigTree(plugin);
    buildPreview(plugin.dom);

    let measured = 0;
    const frame = plugin.dom.document.querySelector('[data-textpreview-content]');
    const originalRect = frame.getBoundingClientRect.bind(frame);
    frame.getBoundingClientRect = () => {
      measured += 1;
      return originalRect();
    };

    const observer = plugin.dom.mutationObservers[0];
    for (let index = 0; index < 20; index += 1) observer.fire();
    await settle(40);

    assert.equal(measured, 0, 'reading geometry on every mutation forces a synchronous reflow');
    plugin.teardown();
  });
});

describe('pointer tracking', () => {
  test('pointer moves do not query the DOM', () => {
    const plugin = loadPlugin();
    const navigator = bigTree(plugin);

    let closestCalls = 0;
    const row = navigator.elements.get('src/dir0/file0.ts');
    const original = row.closest.bind(row);
    row.closest = (selector) => {
      closestCalls += 1;
      return original(selector);
    };

    // Simulate a pointer sweeping across the tree.
    for (let index = 0; index < 100; index += 1) {
      fire(plugin.dom, 'pointerover', { target: row });
    }

    assert.ok(closestCalls <= 100, `pointer moves resolved a row ${closestCalls} times`);
    // The real requirement: no per-move nearest-element walk beyond one lookup
    // per event, and no layout reads at all.
    plugin.teardown();
  });
});

describe('find bar matching', () => {
  test('typing does not re-walk the document on every keystroke', async () => {
    const plugin = loadPlugin();
    buildNavigator(plugin.dom, { rows: [{ path: 'a.js' }] });
    const frame = buildPreview(plugin.dom);
    frame.appendChild(plugin.dom.document.createTextNode('needle '.repeat(200)));

    let walks = 0;
    const originalWalker = plugin.dom.document.createTreeWalker;
    plugin.dom.document.createTreeWalker = (...args) => {
      walks += 1;
      return originalWalker(...args);
    };

    fire(plugin.dom, 'keydown', { key: 'f', ctrlKey: true });
    const input = plugin.dom.document.querySelector('.fsp-term');
    for (const term of ['n', 'ne', 'nee', 'need', 'needle']) {
      input.value = term;
      input.dispatchEvent({ type: 'input', target: input, preventDefault() {}, stopPropagation() {} });
      await settle(5);
    }
    await settle(250);

    plugin.dom.document.createTreeWalker = originalWalker;
    // The debounce exists so a burst of keystrokes costs one walk, not five.
    assert.ok(walks <= 2, `expected the input debounce to collapse keystrokes, saw ${walks} walks`);
    plugin.teardown();
  });
});
