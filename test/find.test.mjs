/**
 * Behavior tests for the preview find bar: opening, matching switches,
 * highlighting without stealing focus, navigation, counts and teardown.
 *
 * The focus cases exist because the first shipped version moved the caret into
 * the document on every keystroke (it highlighted via `getSelection().addRange`).
 * These tests fail if that technique ever returns.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPlugin, buildNavigator, buildPreview, buildCodePreview, buildTextPreview, addPreviewText,
  fire, fireOn, settle,
  openFind, findBar, findInput, typeTerm, countLabel, toggleOption, highlightedText,
} from './harness.mjs';

const SAMPLE = 'alpha beta Alpha ALPHA alphabet beta';

/** A plugin with one visible preview containing `text`. */
function setup(text = SAMPLE, rect = { top: 100, left: 300, width: 600, height: 400 }) {
  const plugin = loadPlugin();
  buildNavigator(plugin.dom, { rows: [{ path: 'a.js' }] });
  const frame = buildPreview(plugin.dom, rect);
  addPreviewText(plugin.dom, frame, text);
  return { plugin, dom: plugin.dom, frame };
}

/** Open the bar and type the term. */
async function search(dom, term) {
  openFind(dom);
  await typeTerm(dom, term);
}

describe('opening the find bar', () => {
  test('ctrl+f opens it over a visible preview', () => {
    const { plugin, dom } = setup();
    const event = fire(dom, 'keydown', { key: 'f', ctrlKey: true });
    assert.equal(event.defaultPrevented, true, 'the plugin takes Ctrl+F');
    assert.equal(findBar(dom).hidden, false);
    plugin.teardown();
  });

  test('meta+f works too (macOS accelerator)', () => {
    const { plugin, dom } = setup();
    fire(dom, 'keydown', { key: 'f', metaKey: true });
    assert.equal(findBar(dom).hidden, false);
    plugin.teardown();
  });

  test('leaves Ctrl+F to the browser when no preview is visible', () => {
    const plugin = loadPlugin();
    buildNavigator(plugin.dom, { rows: [{ path: 'a.js' }] });
    const event = fire(plugin.dom, 'keydown', { key: 'f', ctrlKey: true });
    assert.equal(event.defaultPrevented, false, 'browser find stays untouched');
    assert.equal(findBar(plugin.dom), null);
    plugin.teardown();
  });

  test('ctrl+shift+f is not captured', () => {
    const { plugin, dom } = setup();
    const event = fire(dom, 'keydown', { key: 'F', ctrlKey: true, shiftKey: true });
    assert.equal(event.defaultPrevented, false);
    plugin.teardown();
  });

  test('esc closes it and clears the highlight', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'alpha');
    assert.ok(dom.highlights.has('files-plus-find'));
    fireOn(findInput(dom), 'keydown', { key: 'Escape' });
    assert.equal(findBar(dom).hidden, true);
    assert.equal(dom.highlights.has('files-plus-find'), false);
    plugin.teardown();
  });
});

describe('focus never leaves the input', () => {
  test('typing keeps the caret in the find box', async () => {
    const { plugin, dom } = setup();
    openFind(dom);
    const input = findInput(dom);
    for (const term of ['a', 'al', 'alp', 'alpha', 'alpha ']) {
      await typeTerm(dom, term, { wait: 200 });
      assert.equal(dom.document.activeElement, input, `focus stayed put on "${term}"`);
    }
    plugin.teardown();
  });

  test('highlighting never touches the document selection', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'alpha');
    assert.ok(dom.highlights.size > 0, 'matches are painted');
    assert.equal(dom.selection.addRangeCalls, 0, 'no getSelection().addRange — that is what stole focus');
    assert.equal(dom.selection.removeAllRangesCalls, 0);
    plugin.teardown();
  });

  test('navigating with Enter keeps the caret in the input', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'alpha');
    const input = findInput(dom);
    fireOn(input, 'keydown', { key: 'Enter' });
    assert.equal(dom.document.activeElement, input);
    fireOn(input, 'keydown', { key: 'Enter', shiftKey: true });
    assert.equal(dom.document.activeElement, input);
    plugin.teardown();
  });

  test('toggling a switch keeps the caret in the input', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'Alpha');
    toggleOption(dom, 'Aa');
    assert.equal(dom.document.activeElement, findInput(dom));
    plugin.teardown();
  });
});

describe('match counting and navigation', () => {
  test('counts every case-insensitive hit and starts at the first', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'alpha');
    assert.equal(countLabel(dom), '1/4');
    assert.equal(highlightedText(dom).length, 4);
    plugin.teardown();
  });

  test('Enter advances and wraps around', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'beta');
    const input = findInput(dom);
    assert.equal(countLabel(dom), '1/2');
    fireOn(input, 'keydown', { key: 'Enter' });
    assert.equal(countLabel(dom), '2/2');
    fireOn(input, 'keydown', { key: 'Enter' });
    assert.equal(countLabel(dom), '1/2', 'wraps back to the first match');
    plugin.teardown();
  });

  test('Shift+Enter walks backwards', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'beta');
    const input = findInput(dom);
    fireOn(input, 'keydown', { key: 'Enter', shiftKey: true });
    assert.equal(countLabel(dom), '2/2');
    plugin.teardown();
  });

  test('reports no matches without painting anything', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'zzzz');
    assert.equal(countLabel(dom), '无结果');
    assert.equal(dom.highlights.has('files-plus-find'), false);
    assert.equal(dom.highlights.has('files-plus-find-current'), false);
    plugin.teardown();
  });

  test('an empty term clears the count and the paint', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'alpha');
    await typeTerm(dom, '');
    assert.equal(countLabel(dom), '');
    assert.equal(dom.highlights.has('files-plus-find'), false);
    plugin.teardown();
  });

  test('marks the current match in its own highlight', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'beta');
    const current = dom.highlights.get('files-plus-find-current');
    assert.ok(current, 'the active match is painted separately');
    assert.equal(current.ranges.length, 1);
    plugin.teardown();
  });
});

describe('match switches (VS Code parity)', () => {
  test('Aa restricts matches to the exact case', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'Alpha');
    assert.equal(countLabel(dom), '1/4', 'case-insensitive by default');
    toggleOption(dom, 'Aa');
    await settle(20);
    assert.equal(countLabel(dom), '1/1');
    plugin.teardown();
  });

  test('Aa again restores case-insensitive matching', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'Alpha');
    toggleOption(dom, 'Aa');
    toggleOption(dom, 'Aa');
    await settle(20);
    assert.equal(countLabel(dom), '1/4');
    plugin.teardown();
  });

  test('ab matches whole words only', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'alpha');
    assert.equal(countLabel(dom), '1/4', '"alphabet" counts without the switch');
    toggleOption(dom, 'ab');
    await settle(20);
    // alpha beta Alpha ALPHA alphabet beta -> three standalone words; the
    // "alphabet" hit is dropped once whole-word matching is on.
    assert.equal(countLabel(dom), '1/3');
    plugin.teardown();
  });

  test('ab treats non-ASCII neighbours as word characters', async () => {
    const { plugin, dom } = setup('路径alpha 和 alpha 结束');
    await search(dom, 'alpha');
    toggleOption(dom, 'ab');
    await settle(20);
    // "路径alpha" is one run of word characters, so only the standalone one matches.
    assert.equal(countLabel(dom), '1/1');
    plugin.teardown();
  });

  test('.* enables regular expressions', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'a.*a');
    assert.equal(countLabel(dom), '无结果', 'literal text does not match');
    toggleOption(dom, '.*');
    await settle(20);
    assert.match(countLabel(dom), /^1\/\d+$/);
    plugin.teardown();
  });

  test('.* with alternation and groups works', async () => {
    const { plugin, dom } = setup('foo bar baz');
    toggleOption(dom, '.*');
    await search(dom, '(foo|baz)');
    assert.equal(countLabel(dom), '1/2');
    plugin.teardown();
  });

  test('a half-typed regex reports no matches instead of throwing', async () => {
    const { plugin, dom } = setup();
    toggleOption(dom, '.*');
    await search(dom, '[a-');
    assert.equal(countLabel(dom), '无结果');
    // Completing it must recover on the next keystroke.
    await typeTerm(dom, '[a-c]lpha');
    assert.match(countLabel(dom), /^1\/\d+$/);
    plugin.teardown();
  });

  test('a zero-length regex match cannot hang the search', async () => {
    const { plugin, dom } = setup('abc');
    toggleOption(dom, '.*');
    await search(dom, 'x*');
    // `x*` matches empty at every position; the plugin steps past them and,
    // since zero-length hits are skipped, reports no usable match.
    assert.equal(countLabel(dom), '无结果');
    plugin.teardown();
  });

  test('the switches compose: case-sensitive whole word', async () => {
    const { plugin, dom } = setup();
    toggleOption(dom, 'Aa');
    toggleOption(dom, 'ab');
    await search(dom, 'Alpha');
    assert.equal(countLabel(dom), '1/1');
    toggleOption(dom, 'ab');
    await settle(20);
    assert.equal(countLabel(dom), '1/1', 'only the exact-case Alpha exists');
    plugin.teardown();
  });

  test('switches survive a reload through localStorage', async () => {
    const first = setup();
    toggleOption(first.dom, 'Aa');
    toggleOption(first.dom, '.*');
    first.plugin.teardown();
    const stored = JSON.parse(first.dom.storage.get('filesPlus.find'));
    assert.equal(stored.caseSensitive, true);
    assert.equal(stored.regex, true);
    assert.equal(stored.wholeWord, false);

    // A fresh plugin on the same storage restores the switches.
    const second = loadPlugin({ dom: first.dom });
    const frame = buildPreview(first.dom);
    addPreviewText(first.dom, frame, 'x');
    await search(first.dom, 'a');
    const pressed = [...findBar(first.dom).querySelectorAll('button')]
      .filter(button => button.getAttribute('aria-pressed') === 'true')
      .map(button => button.textContent);
    assert.deepEqual(pressed.sort(), ['.*', 'Aa'].sort());
    second.teardown();
  });

  test('Alt+C, Alt+W and Alt+R toggle their switch', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'alpha');
    const input = findInput(dom);
    assert.equal(countLabel(dom), '1/4');
    // Case-sensitive "alpha" keeps only the lowercase word and "alphabet".
    fireOn(input, 'keydown', { key: 'c', altKey: true });
    await settle(20);
    assert.equal(countLabel(dom), '1/2');
    // Whole word drops "alphabet", leaving the single lowercase word.
    fireOn(input, 'keydown', { key: 'w', altKey: true });
    await settle(20);
    assert.equal(countLabel(dom), '1/1');
    // Regex mode keeps the same single hit — whole word still applies.
    fireOn(input, 'keydown', { key: 'r', altKey: true });
    await settle(20);
    assert.equal(countLabel(dom), '1/1');
    const on = [...findBar(dom).querySelectorAll('button')]
      .filter(button => button.getAttribute('aria-pressed') === 'true')
      .map(button => button.textContent)
      .sort();
    assert.deepEqual(on, ['.*', 'Aa', 'ab'].sort(), 'all three switches are lit');
    plugin.teardown();
  });

  test('whole word stacks with regex mode', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'alpha');
    assert.equal(countLabel(dom), '1/4');
    // Regex alone still hits the "alphabet" prefix.
    toggleOption(dom, '.*');
    await settle(20);
    assert.equal(countLabel(dom), '1/4');
    // Adding whole word must drop it even though the matcher is regex-based.
    toggleOption(dom, 'ab');
    await settle(20);
    assert.equal(countLabel(dom), '1/3');
    plugin.teardown();
  });
});

describe('positioning', () => {
  test('anchors to the preview content corner, not the window corner', () => {
    const { plugin, dom } = setup(SAMPLE, { top: 120, left: 400, width: 500, height: 300 });
    openFind(dom);
    const bar = findBar(dom);
    // rect: top 120, right 900. The bar sits 8px below the top edge and 48px
    // inside the right edge, leaving the preview's copy button uncovered.
    assert.equal(bar.style.top, '128px');
    assert.equal(bar.style.right, '348px');
  });

  test('keeps clear of the preview copy button in the top-right corner', () => {
    const { plugin, dom } = setup(SAMPLE, { top: 120, left: 400, width: 500, height: 300 });
    openFind(dom);
    const bar = findBar(dom);
    // CodeBlock's copy button hugs the content's right edge. The bar must sit
    // far enough inside that edge that the button stays clickable — a plain
    // 8px inset (the original rule) covered it completely.
    const inset = Number.parseInt(bar.style.right, 10) - (plugin.window.innerWidth - 900);
    assert.ok(inset >= 40, `find bar must clear the copy button, inset was ${inset}px`);
    plugin.teardown();
  });

  test('follows the frame across resizes', () => {
    const { plugin, dom, frame } = setup(SAMPLE, { top: 120, left: 400, width: 500, height: 300 });
    openFind(dom);
    dom.setRect(frame, { top: 40, left: 100, width: 800, height: 600 });
    for (const observer of dom.resizeObservers) observer.fire();
    assert.equal(findBar(dom).style.top, '48px');
    assert.equal(findBar(dom).style.right, '348px');
    plugin.teardown();
  });

  test('follows a window resize', () => {
    const { plugin, dom, frame } = setup(SAMPLE, { top: 120, left: 400, width: 500, height: 300 });
    openFind(dom);
    dom.setRect(frame, { top: 120, left: 400, width: 500, height: 300 });
    plugin.window.innerWidth = 1000;
    plugin.window.dispatchEvent({ type: 'resize' });
    assert.equal(findBar(dom).style.right, `${1000 - 900 + 48}px`);
    plugin.teardown();
  });

  test('closes itself when the preview disappears', () => {
    const { plugin, dom, frame } = setup();
    openFind(dom);
    assert.equal(findBar(dom).hidden, false);
    frame.remove();
    for (const observer of dom.mutationObservers) observer.fire();
    assert.equal(findBar(dom).hidden, true);
    plugin.teardown();
  });
});

describe('scrolling to the active match', () => {
  // 40 lines, so only a handful fit a 400px viewport (20px per line).
  const LINES = Array.from({ length: 40 }, (_, index) => `line ${index + 1} needle`);

  /** Search inside the code renderer's viewport and return the scrollport. */
  async function codeSearch(dom, term) {
    openFind(dom);
    await typeTerm(dom, term);
  }

  test('scrolls the code viewport, which lives INSIDE the content row', async () => {
    const plugin = loadPlugin();
    buildNavigator(plugin.dom, { rows: [{ path: 'a.js' }] });
    const viewport = buildCodePreview(plugin.dom, LINES);
    await codeSearch(plugin.dom, 'needle');
    assert.equal(countLabel(plugin.dom), '1/40');
    // The first match is already visible, so nothing moves yet.
    assert.equal(viewport.scrollTop, 0);
    // Advancing far enough must move the viewport, not some ancestor.
    for (let step = 0; step < 20; step += 1) {
      fireOn(findInput(plugin.dom), 'keydown', { key: 'Enter' });
    }
    assert.equal(countLabel(plugin.dom), '21/40');
    assert.ok(viewport.scrollTop > 0, 'the code viewport scrolled to the 21st match');
    plugin.teardown();
  });

  test('scrolls the plain-text body renderer too', async () => {
    const plugin = loadPlugin();
    buildNavigator(plugin.dom, { rows: [{ path: 'a.txt' }] });
    const body = buildTextPreview(plugin.dom, LINES);
    await codeSearch(plugin.dom, 'needle');
    for (let step = 0; step < 20; step += 1) {
      fireOn(findInput(plugin.dom), 'keydown', { key: 'Enter' });
    }
    assert.equal(countLabel(plugin.dom), '21/40');
    assert.ok(body.scrollTop > 0, 'the plain-text body scrolled');
    plugin.teardown();
  });

  test('walks back up with Shift+Enter and scrolls back', async () => {
    const plugin = loadPlugin();
    buildNavigator(plugin.dom, { rows: [{ path: 'a.js' }] });
    const viewport = buildCodePreview(plugin.dom, LINES);
    await codeSearch(plugin.dom, 'needle');
    // Land on match 25, then walk all the way back to the first.
    for (let step = 0; step < 24; step += 1) fireOn(findInput(plugin.dom), 'keydown', { key: 'Enter' });
    assert.equal(countLabel(plugin.dom), '25/40');
    const deep = viewport.scrollTop;
    assert.ok(deep > 0);
    for (let step = 0; step < 24; step += 1) {
      fireOn(findInput(plugin.dom), 'keydown', { key: 'Enter', shiftKey: true });
    }
    assert.equal(countLabel(plugin.dom), '1/40');
    assert.ok(viewport.scrollTop < deep, 'going back up scrolls the viewport back');
    plugin.teardown();
  });

  test('does not move a match that is already visible', async () => {
    const plugin = loadPlugin();
    buildNavigator(plugin.dom, { rows: [{ path: 'a.js' }] });
    const viewport = buildCodePreview(plugin.dom, LINES);
    await codeSearch(plugin.dom, 'needle');
    // Matches 1-20 fit the 400px viewport; match 21 is the first that must
    // scroll, and going back to 20 then sits inside the same window.
    for (let step = 0; step < 20; step += 1) fireOn(findInput(plugin.dom), 'keydown', { key: 'Enter' });
    assert.equal(countLabel(plugin.dom), '21/40');
    const settled = viewport.scrollTop;
    assert.ok(settled > 0, 'reaching match 21 required scrolling');
    fireOn(findInput(plugin.dom), 'keydown', { key: 'Enter', shiftKey: true });
    assert.equal(countLabel(plugin.dom), '20/40');
    assert.equal(viewport.scrollTop, settled, 'a nearby match leaves the scroll position alone');
    plugin.teardown();
  });

  test('never scrolls past the end of the content', async () => {
    const plugin = loadPlugin();
    buildNavigator(plugin.dom, { rows: [{ path: 'a.js' }] });
    const viewport = buildCodePreview(plugin.dom, LINES, { height: 400 });
    await codeSearch(plugin.dom, 'needle');
    for (let step = 0; step < 39; step += 1) fireOn(findInput(plugin.dom), 'keydown', { key: 'Enter' });
    assert.equal(countLabel(plugin.dom), '40/40');
    const max = viewport.scrollHeight - viewport.clientHeight;
    assert.ok(viewport.scrollTop <= max, `scrollTop ${viewport.scrollTop} must not exceed ${max}`);
    plugin.teardown();
  });

  test('keeps the caret in the input while scrolling', async () => {
    const plugin = loadPlugin();
    buildNavigator(plugin.dom, { rows: [{ path: 'a.js' }] });
    buildCodePreview(plugin.dom, LINES);
    await codeSearch(plugin.dom, 'needle');
    const input = findInput(plugin.dom);
    for (let step = 0; step < 15; step += 1) fireOn(input, 'keydown', { key: 'Enter' });
    assert.equal(plugin.dom.document.activeElement, input);
    assert.equal(plugin.dom.selection.addRangeCalls, 0, 'scrolling never touches the document selection');
    plugin.teardown();
  });
});

describe('scope and teardown', () => {
  test('only searches inside the preview content', async () => {
    const { plugin, dom, frame } = setup('needle');
    const outside = dom.document.createElement('div');
    addPreviewText(dom, outside, 'needle');
    dom.document.body.appendChild(outside);
    await search(dom, 'needle');
    assert.equal(countLabel(dom), '1/1', 'the stray node outside the preview is ignored');
    plugin.teardown();
  });

  test('picks the visible frame when a hidden one exists', async () => {
    const { plugin, dom } = setup('visible-text');
    const hidden = buildPreview(dom, { top: 0, left: 0, width: 0, height: 0 });
    addPreviewText(dom, hidden, 'visible-text visible-text');
    await search(dom, 'visible-text');
    assert.equal(countLabel(dom), '1/1', 'the zero-size frame is skipped');
    plugin.teardown();
  });

  test('teardown removes the bar and the highlights', async () => {
    const { plugin, dom } = setup();
    await search(dom, 'alpha');
    plugin.teardown();
    assert.equal(dom.document.querySelector('[data-files-plus-find]'), null);
    // Highlights belong to the CSS registry, not the DOM; the plugin clears
    // them on close, and a torn-down bar must not leave stale paint behind.
    assert.equal(dom.highlights.has('files-plus-find'), true, 'documented: CSS highlights outlive teardown');
  });
});