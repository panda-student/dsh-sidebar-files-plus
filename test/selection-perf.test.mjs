/**
 * Correctness probes for the marked-row bookkeeping.
 *
 * The performance change remembers which row elements were painted so clearing
 * a selection does not rescan the tree. That cache must never drift from what is
 * actually on screen, or selection marks would go stale in a way the timing
 * probes cannot see.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin, buildNavigator, fire, settle } from './harness.mjs';

function setup(rows) {
  const plugin = loadPlugin();
  const navigator = buildNavigator(plugin.dom, {
    rows: rows ?? [
      { path: 'src/dir', kind: 'directory' },
      { path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' },
    ],
  });
  plugin.sessions.byId['s1'] = { sessionId: 's1', cwd: '/ws', retainedBy: { mainView: 1 } };
  return { plugin, navigator, dom: plugin.dom };
}

function marked(navigator) {
  return [...navigator.elements.entries()]
    .filter(([, element]) => element.getAttribute('data-files-plus-selected') === '1')
    .map(([path]) => path)
    .sort();
}

describe('clearing a selection by plain click', () => {
  test('a folder click unmarks every previously selected row', () => {
    const { plugin, navigator, dom } = setup();
    fire(dom, 'click', { target: navigator.elements.get('src/a.ts'), ctrlKey: true });
    fire(dom, 'click', { target: navigator.elements.get('src/c.ts'), ctrlKey: true });
    assert.deepEqual(marked(navigator), ['src/a.ts', 'src/c.ts']);

    fire(dom, 'click', { target: navigator.elements.get('src/dir') });
    assert.deepEqual(marked(navigator), [], 'the folder click clears the stale group');
    plugin.teardown();
  });

  test('no stale mark survives when the selection became empty', () => {
    const { plugin, navigator, dom } = setup();
    fire(dom, 'click', { target: navigator.elements.get('src/b.ts'), ctrlKey: true });
    assert.deepEqual(marked(navigator), ['src/b.ts']);
    // Clicking the same row again toggles it off: the mark must disappear.
    fire(dom, 'click', { target: navigator.elements.get('src/b.ts'), ctrlKey: true });
    assert.deepEqual(marked(navigator), []);
    plugin.teardown();
  });

  test('marks still restore after the official renderer replaces the rows', async () => {
    const { plugin, navigator } = setup();
    fire(plugin.dom, 'click', { target: navigator.elements.get('src/a.ts'), ctrlKey: true });
    // Official re-render wipes the attribute, then a mutation arrives.
    navigator.elements.get('src/a.ts').removeAttribute('data-files-plus-selected');
    for (const observer of plugin.dom.mutationObservers) observer.fire();
    await new Promise(resolve => queueMicrotask(resolve));
    assert.deepEqual(marked(navigator), ['src/a.ts'], 'the mark comes back after a re-render');
    plugin.teardown();
  });

  test('a row removed from the tree does not keep a mark alive', async () => {
    const { plugin, navigator, dom } = setup();
    fire(dom, 'click', { target: navigator.elements.get('src/a.ts'), ctrlKey: true });
    // The renderer drops the node entirely (e.g. its folder collapsed).
    const removed = navigator.elements.get('src/a.ts');
    removed.remove();
    for (const observer of plugin.dom.mutationObservers) observer.fire();
    await new Promise(resolve => queueMicrotask(resolve));

    // The detached node must not keep the attribute: nothing on screen shows it,
    // and holding it would let a later send act on an invisible row.
    assert.equal(removed.getAttribute('data-files-plus-selected'), null,
      'the mark is cleared from the detached row');
    assert.deepEqual(marked(navigator), []);
    // Clearing afterwards must not throw and must leave nothing behind.
    fire(dom, 'click', { target: navigator.elements.get('src/dir') });
    assert.deepEqual(marked(navigator), []);
    plugin.teardown();
  });

  test('clearing stays fast on a large tree', () => {
    const rows = [
      { path: 'src/dir', kind: 'directory' },
      ...Array.from({ length: 3000 }, (_, index) => ({ path: `src/f${index}.ts` })),
    ];
    const { plugin, navigator } = setup(rows);
    for (let index = 0; index < 5; index += 1) {
      fire(plugin.dom, 'click', { target: navigator.elements.get(`src/f${index}.ts`), ctrlKey: true });
    }
    const started = process.hrtime.bigint();
    fire(plugin.dom, 'click', { target: navigator.elements.get('src/dir') });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // A full scan of 3000 rows measured >20 ms on this machine; the marked-row
    // path must stay far below that so tree size cannot reintroduce the lag.
    assert.ok(ms < 5, `clearing a 5-row selection in a 3000-row tree took ${ms.toFixed(1)} ms`);
    plugin.teardown();
  });
});
