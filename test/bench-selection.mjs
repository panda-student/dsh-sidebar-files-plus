/**
 * How does clearing a selection scale with tree size?
 *
 * A plain folder click clears the stale selection and repaints. Today that
 * repaint walks every row in the pane, so its cost tracks the whole tree rather
 * than the handful of rows the user actually selected.
 */
import { loadPlugin, buildNavigator, fire, settle } from './harness.mjs';

async function measure(rowCount) {
  const plugin = loadPlugin();
  const rows = [
    { path: 'src/dir', kind: 'directory' },
    ...Array.from({ length: rowCount }, (_, i) => ({ path: `src/f${i}.ts` })),
  ];
  const navigator = buildNavigator(plugin.dom, { rows });
  plugin.sessions.byId['s1'] = { sessionId: 's1', cwd: '/ws', retainedBy: { mainView: 1 } };
  // Select 5 rows: a realistic hand-picked selection.
  for (let i = 0; i < 5; i += 1) {
    fire(plugin.dom, 'click', { target: navigator.elements.get(`src/f${i}.ts`), ctrlKey: true });
  }
  // Warm up, then time the clearing click that a folder click performs.
  fire(plugin.dom, 'click', { target: navigator.elements.get('src/dir') });
  for (let i = 0; i < 5; i += 1) {
    fire(plugin.dom, 'click', { target: navigator.elements.get(`src/f${i}.ts`), ctrlKey: true });
  }
  const started = process.hrtime.bigint();
  fire(plugin.dom, 'click', { target: navigator.elements.get('src/dir') });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  plugin.teardown();
  return ms;
}

for (const count of [100, 500, 1000, 2000, 4000]) {
  const ms = await measure(count);
  console.log(`${String(count).padStart(5)} rows -> clearing selection costs ${ms.toFixed(2)} ms`);
}
