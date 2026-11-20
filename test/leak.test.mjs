/**
 * Leak probes: does repeated interaction leave unbounded per-pane state behind?
 *
 * A user moving the mouse around a tree for a while should not accumulate
 * memory in the plugin. This measures the bookkeeping structures directly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin, buildNavigator, fire, settle } from './harness.mjs';

describe('per-pane bookkeeping stays bounded', () => {
  test('repeated clicks do not grow the marked list beyond the selection', async () => {
    const plugin = loadPlugin();
    const rows = Array.from({ length: 200 }, (_, i) => ({ path: `src/f${i}.ts` }));
    const navigator = buildNavigator(plugin.dom, { rows });
    plugin.sessions.byId['s1'] = { sessionId: 's1', cwd: '/ws', retainedBy: { mainView: 1 } };

    // Hammer: select a row, then clear it, many times over.
    for (let round = 0; round < 300; round += 1) {
      const path = `src/f${round % 200}.ts`;
      fire(plugin.dom, 'click', { target: navigator.elements.get(path), ctrlKey: true });
      fire(plugin.dom, 'click', { target: navigator.elements.get(path) });
      for (const observer of plugin.dom.mutationObservers) observer.fire();
      await settle(2);
    }

    // Nothing is selected now; no row may keep a stale mark.
    const marked = [...navigator.elements.values()]
      .filter(element => element.getAttribute('data-files-plus-selected') === '1');
    assert.equal(marked.length, 0, 'no row is left marked after clearing');
    plugin.teardown();
  });

  test('adding rows does not make an idle mutation repaint them', async () => {
    const plugin = loadPlugin();
    const navigator = buildNavigator(plugin.dom, { rows: [{ path: 'src/a.ts' }] });
    plugin.sessions.byId['s1'] = { sessionId: 's1', cwd: '/ws', retainedBy: { mainView: 1 } };

    // Grow the tree to a realistic size without ever selecting anything.
    for (let i = 0; i < 500; i += 1) {
      const row = plugin.dom.document.createElement('div');
      row.setAttribute('data-files-path', `src/g${i}.ts`);
      row.setAttribute('data-files-entry', 'file');
      row.appendChild(plugin.dom.document.createElement('button'));
      navigator.nav.appendChild(row);
    }

    let writes = 0;
    for (const element of navigator.nav.querySelectorAll('[data-files-path]')) {
      const set = element.setAttribute.bind(element);
      element.setAttribute = (...args) => { writes += 1; return set(...args); };
    }

    for (const observer of plugin.dom.mutationObservers) observer.fire();
    await settle(20);

    assert.equal(writes, 0, 'with nothing selected, mutations must not touch any row');
    plugin.teardown();
  });

  test('no document-wide pointer listener is installed', () => {
    const plugin = loadPlugin();
    buildNavigator(plugin.dom, { rows: [{ path: 'src/a.ts' }] });
    const pointerEvents = ['pointerover', 'pointermove', 'pointerenter', 'mouseover', 'mousemove', 'mouseenter'];
    for (const type of pointerEvents) {
      const bound = plugin.dom.document.listeners.get(type);
      assert.equal(bound?.size ?? 0, 0,
        `a document-level "${type}" listener runs on every move across the whole app`);
    }
    plugin.teardown();
  });
});
