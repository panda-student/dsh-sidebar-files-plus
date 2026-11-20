/**
 * Timing probe: how much wall-clock time a mutation burst costs.
 *
 * Kept separate from the assertions in perf.test.mjs so the number is readable
 * on its own. Run with `node test/bench.mjs`.
 */
import { loadPlugin, buildNavigator, buildPreview, fire, settle } from './harness.mjs';

const ROWS = 500;
const BURST = 300;

function build() {
  const plugin = loadPlugin();
  const rows = Array.from({ length: ROWS }, (_, index) => ({ path: `src/d${index}/f${index}.ts` }));
  const navigator = buildNavigator(plugin.dom, { rows });
  plugin.sessions.byId['s1'] = { sessionId: 's1', cwd: '/ws', retainedBy: { mainView: 1 } };
  buildPreview(plugin.dom);
  return { plugin, navigator };
}

async function bench(label, { select }) {
  const { plugin, navigator } = build();
  if (select) {
    // Select a quarter of the tree so paint has real work to do.
    for (let index = 0; index < ROWS; index += 4) {
      fire(plugin.dom, 'contextmenu', { target: navigator.elements.get(`src/d${index}/f${index}.ts`), button: 2 });
      // Right-click replaces the selection; re-add through ctrl-click instead.
    }
    const first = navigator.elements.get('src/d0/f0.ts');
    fire(plugin.dom, 'click', { target: first, ctrlKey: true });
    for (let index = 4; index < ROWS; index += 4) {
      fire(plugin.dom, 'click', { target: navigator.elements.get(`src/d${index}/f${index}.ts`), ctrlKey: true });
    }
  }
  const observer = plugin.dom.mutationObservers[0];
  const started = process.hrtime.bigint();
  for (let index = 0; index < BURST; index += 1) observer.fire();
  await settle(30);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`${label}: ${BURST} mutations over ${ROWS} rows -> ${elapsed.toFixed(1)} ms`);
  plugin.teardown();
  return elapsed;
}

console.log('--- mutation burst cost ---');
await bench('empty selection ', { select: false });
await bench('quarted selected', { select: true });
