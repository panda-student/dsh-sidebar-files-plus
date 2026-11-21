/**
 * Behavior tests for the selection, menu, send and open gestures.
 *
 * Every case drives the real `client.js` through the harness: no logic is
 * re-implemented here, so a passing run means the shipped plugin does what the
 * plan promises.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  loadPlugin, buildNavigator, buildPreview, fire, settle,
} from './harness.mjs';

const ROWS = [
  { path: 'src/a.ts' },
  { path: 'src/b.ts' },
  { path: 'src/dir', kind: 'directory' },
  { path: 'docs/readme.md' },
];

/** A plugin plus a navigator, wired the way the app renders them. */
function setup(options = {}) {
  const plugin = loadPlugin(options);
  const navigator = buildNavigator(plugin.dom, { rows: ROWS, ...options.navigator });
  plugin.sessions.byId['s1'] = { sessionId: 's1', cwd: '/ws', retainedBy: { mainView: 1 } };
  return { plugin, navigator, dom: plugin.dom };
}

/** Selected-row attributes currently painted in the pane. */
function selectedPaths(navigator) {
  const selected = [];
  for (const [path, element] of navigator.elements) {
    if (element.getAttribute('data-files-plus-selected') === '1') selected.push(path);
  }
  return selected.sort();
}

/** Right-click a row the way a user does. */
function rightClick(dom, element, init = {}) {
  return fire(dom, 'contextmenu', { target: element, button: 2, ...init });
}

/** Left-click a row with modifiers. */
function click(dom, element, init = {}) {
  return fire(dom, 'click', { target: element, ...init });
}

describe('right-click selection', () => {
  test('right-clicking a row selects exactly that row', () => {
    const { plugin, navigator, dom } = setup();
    rightClick(dom, navigator.elements.get('src/a.ts'));
    assert.deepEqual(selectedPaths(navigator), ['src/a.ts']);
    plugin.teardown();
  });

  test('right-clicking moves the selection to the new row', () => {
    const { plugin, navigator, dom } = setup();
    rightClick(dom, navigator.elements.get('src/a.ts'));
    rightClick(dom, navigator.elements.get('src/b.ts'));
    assert.deepEqual(selectedPaths(navigator), ['src/b.ts']);
    plugin.teardown();
  });

  test('right-clicking a row inside the selection keeps the whole group', () => {
    const { plugin, navigator, dom } = setup();
    click(dom, navigator.elements.get('src/a.ts'), { ctrlKey: true });
    click(dom, navigator.elements.get('src/b.ts'), { ctrlKey: true });
    assert.deepEqual(selectedPaths(navigator), ['src/a.ts', 'src/b.ts']);
    rightClick(dom, navigator.elements.get('src/a.ts'));
    assert.deepEqual(selectedPaths(navigator), ['src/a.ts', 'src/b.ts']);
    plugin.teardown();
  });

  test('plain click does not select, and clears a stale selection', () => {
    const { plugin, navigator, dom } = setup();
    rightClick(dom, navigator.elements.get('src/a.ts'));
    assert.deepEqual(selectedPaths(navigator), ['src/a.ts']);
    const event = click(dom, navigator.elements.get('docs/readme.md'));
    // The official click behavior must survive: no default prevented, no
    // stopPropagation, so the official handler still opens the preview.
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
    assert.deepEqual(selectedPaths(navigator), []);
    plugin.teardown();
  });

  test('ctrl+click adds and removes without opening anything', () => {
    const { plugin, navigator, dom } = setup();
    const first = click(dom, navigator.elements.get('src/a.ts'), { ctrlKey: true });
    assert.equal(first.defaultPrevented, true, 'the plugin owns the modifier gesture');
    click(dom, navigator.elements.get('src/b.ts'), { ctrlKey: true });
    assert.deepEqual(selectedPaths(navigator), ['src/a.ts', 'src/b.ts']);
    click(dom, navigator.elements.get('src/b.ts'), { ctrlKey: true });
    assert.deepEqual(selectedPaths(navigator), ['src/a.ts']);
    plugin.teardown();
  });

  test('shift+click selects the range from the anchor', () => {
    const { plugin, navigator, dom } = setup();
    click(dom, navigator.elements.get('src/a.ts'), { ctrlKey: true });
    click(dom, navigator.elements.get('docs/readme.md'), { shiftKey: true });
    assert.deepEqual(selectedPaths(navigator), [
      'docs/readme.md', 'src/a.ts', 'src/b.ts', 'src/dir',
    ]);
    plugin.teardown();
  });

  test('ctrl+a selects every row in the pane the user last worked in', () => {
    const { plugin, navigator, dom } = setup();
    const other = buildNavigator(dom, { paneId: 'pane-2', rows: [{ path: 'x.ts' }] });
    // The pane is identified by a click, not by hovering: the plugin no longer
    // watches pointer movement.
    fire(dom, 'click', { target: navigator.elements.get('src/a.ts'), ctrlKey: true });
    const event = fire(dom, 'keydown', { key: 'a', ctrlKey: true });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(selectedPaths(navigator), [
      'docs/readme.md', 'src/a.ts', 'src/b.ts', 'src/dir',
    ]);
    assert.deepEqual(selectedPaths(other), [], 'the other pane keeps its empty selection');
    plugin.teardown();
  });

  test('ctrl+a does nothing until the user has touched a tree', () => {
    const { plugin, navigator, dom } = setup();
    const event = fire(dom, 'keydown', { key: 'a', ctrlKey: true });
    assert.equal(event.defaultPrevented, false, 'no pane is in play, so Ctrl+A is left alone');
    assert.deepEqual(selectedPaths(navigator), []);
    plugin.teardown();
  });

  test('ctrl+a leaves a focused text field alone', () => {
    const { plugin, navigator, dom } = setup();
    const input = dom.document.createElement('input');
    dom.document.body.appendChild(input);
    input.focus();
    fire(dom, 'click', { target: navigator.elements.get('src/a.ts'), ctrlKey: true });
    const before = selectedPaths(navigator);
    const event = fire(dom, 'keydown', { key: 'a', ctrlKey: true });
    assert.equal(event.defaultPrevented, false, 'typing contexts keep Ctrl+A');
    assert.deepEqual(selectedPaths(navigator), before, 'the tree selection is untouched');
    plugin.teardown();
  });

  test('a repaint after the official re-render restores the marks', async () => {
    const { plugin, navigator, dom } = setup();
    rightClick(dom, navigator.elements.get('src/a.ts'));
    // Official re-render: a fresh element replaces the row, losing attributes.
    navigator.elements.get('src/a.ts').removeAttribute('data-files-plus-selected');
    for (const observer of dom.mutationObservers) observer.fire();
    // The repaint is coalesced onto a microtask so a mutation burst costs one
    // pass; the marks still come back, just not synchronously.
    await new Promise(resolve => queueMicrotask(resolve));
    assert.deepEqual(selectedPaths(navigator), ['src/a.ts']);
    plugin.teardown();
  });
});

describe('context menu contributions', () => {
  test('only the send entries are registered — copy and open-with-app stay official', () => {
    const { plugin } = setup();
    const ids = plugin.menus.map(entry => `${entry.id}:${entry.target}`).sort();
    assert.deepEqual(ids, ['files-plus.send:directory', 'files-plus.send:file']);
    plugin.teardown();
  });

  test('the send entry carries the localized label', () => {
    const { plugin } = setup();
    const [entry] = plugin.menu('files-plus.send', 'file').resolve({ sessionId: 's1', path: 'src/a.ts' });
    assert.equal(entry.label, '发送到对话');
    plugin.teardown();
  });

  test('the send entry names an icon, matching the neighbouring official rows', () => {
    const { plugin } = setup();
    for (const target of ['file', 'directory']) {
      const [entry] = plugin.menu('files-plus.send', target).resolve({ sessionId: 's1', path: 'src/a.ts', paneId: 'pane-1' });
      assert.equal(entry.icon?.key, 'files-plus.send', `${target} row declares an icon key`);
    }
    plugin.teardown();
  });

  test('the declared icon key binds the official send glyph', () => {
    const { plugin } = setup();
    const bind = plugin.slots.icons.get('files-plus.send');
    assert.ok(bind !== undefined, 'contextMenu.icon is registered for the send key');
    const rendered = bind({});
    assert.equal(rendered.icon, 'IconSendOutlineRegular', 'the menu row renders the official send icon');
    plugin.teardown();
  });

  test('menu targets resolve to the whole selection when the row is selected', () => {
    const { plugin, navigator, dom } = setup();
    click(dom, navigator.elements.get('src/a.ts'), { ctrlKey: true });
    click(dom, navigator.elements.get('src/dir'), { ctrlKey: true });
    const applied = [];
    plugin.dom.document.body.appendChild(plugin.dom.document.createElement('div'));
    // Replace the composer with a recorder so we can see what the menu sends.
    const session = { scopes: plugin.sessions.scopes };
    session.scopes.set('s1', undefined);
    plugin.mountComposer('s1', {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
      insertText: (text) => {
        applied.push(text);
        return true;
      },
    });
    const [entry] = plugin.menu('files-plus.send', 'file').resolve({ sessionId: 's1', path: 'src/a.ts', paneId: 'pane-1' });
    entry.run();
    return settle(10).then(() => {
      assert.deepEqual(applied.sort(), ['@src/a.ts ', '@src/dir/ ']);
      plugin.teardown();
    });
  });
});

describe('send-to-composer chips', () => {
  test('uses the official insertReference channel with a short label', async () => {
    const { plugin } = setup();
    const references = [];
    const scope = {
      get: name => (name === 'conversation'
        ? { input: { for: () => ({ insertReference: (ref, span) => {
          references.push({ ref, span });
          return true;
        } }) } }
        : undefined),
    };
    plugin.sessions.scopes.set('s1', scope);
    const texts = [];
    plugin.mountComposer('s1', {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 3 }),
      insertText: text => { texts.push(text); return true; },
    });

    const [entry] = plugin.menu('files-plus.send', 'file').resolve({ sessionId: 's1', path: 'docs/readme.md', paneId: 'pane-1' });
    entry.run();
    await settle(10);

    assert.equal(references.length, 1, 'one chip, not plain text');
    assert.equal(texts.length, 0, 'no plain-text fallback when the chip channel works');
    const [{ ref, span }] = references;
    assert.equal(ref.label, 'readme.md', 'the chip shows only the last path segment');
    assert.equal(ref.ref, '@docs/readme.md', 'the sent text keeps the full mention');
    assert.equal(ref.appearance, 'file');
    // Cross-realm span object: compare fields.
    assert.equal(span.start, 0);
    assert.equal(span.end, 0);
    assert.equal(span.draftRev, 3);
    plugin.teardown();
  });

  test('directories get the folder appearance and a trailing slash', async () => {
    const { plugin } = setup();
    const references = [];
    plugin.sessions.scopes.set('s1', {
      get: () => ({ input: { for: () => ({ insertReference: ref => { references.push(ref); return true; } }) } }),
    });
    plugin.mountComposer('s1', {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
      insertText: () => true,
    });
    const [entry] = plugin.menu('files-plus.send', 'directory').resolve({ sessionId: 's1', path: 'src/dir', paneId: 'pane-1' });
    entry.run();
    await settle(10);
    assert.equal(references[0].appearance, 'folder');
    assert.equal(references[0].ref, '@src/dir/');
    assert.equal(references[0].label, 'dir');
    plugin.teardown();
  });

  test('falls back to plain text when the chip channel is unavailable', async () => {
    const { plugin } = setup();
    const texts = [];
    plugin.mountComposer('s1', {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 2 }),
      insertText: (text) => { texts.push(text); return true; },
    });
    const [entry] = plugin.menu('files-plus.send', 'file').resolve({ sessionId: 's1', path: 'src/a.ts', paneId: 'pane-1' });
    entry.run();
    await settle(10);
    assert.deepEqual(texts, ['@src/a.ts ']);
    assert.equal(plugin.dom.notifications.at(-1).ok, true);
    plugin.teardown();
  });

  test('reports when no composer is mounted', async () => {
    const { plugin } = setup();
    const [entry] = plugin.menu('files-plus.send', 'file').resolve({ sessionId: 's1', path: 'src/a.ts', paneId: 'pane-1' });
    entry.run();
    await settle(10);
    assert.equal(plugin.dom.notifications.at(-1).message, '输入框暂不可用，请确认会话已打开');
    assert.equal(plugin.dom.notifications.at(-1).ok, false);
    plugin.teardown();
  });

  test('quotes paths containing spaces', async () => {
    const { plugin } = setup();
    const texts = [];
    plugin.mountComposer('s1', {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
      insertText: text => { texts.push(text); return true; },
    });
    const [entry] = plugin.menu('files-plus.send', 'file').resolve({ sessionId: 's1', path: 'docs/my note.md', paneId: 'pane-1' });
    entry.run();
    await settle(10);
    assert.deepEqual(texts, ['@"docs/my note.md" ']);
    plugin.teardown();
  });
});

describe('double-click office files', () => {
  const officeRows = [{ path: 'report.xlsx' }, { path: 'notes.md' }];

  function officeSetup() {
    const plugin = loadPlugin();
    const navigator = buildNavigator(plugin.dom, { rows: officeRows });
    plugin.sessions.byId['s1'] = { sessionId: 's1', cwd: '/ws', retainedBy: { mainView: 1 } };
    return { plugin, navigator, dom: plugin.dom };
  }

  test('opens whitelisted office files with the system app', async () => {
    const { plugin, navigator, dom } = officeSetup();
    const event = fire(dom, 'dblclick', { target: navigator.elements.get('report.xlsx') });
    assert.equal(event.defaultPrevented, true);
    await settle(10);
    // Cross-realm objects: compare the payload, not the prototype chain.
    assert.equal(dom.openCalls.length, 1);
    assert.equal(dom.openCalls[0].path, '/ws/report.xlsx');
    plugin.teardown();
  });

  test('leaves non-whitelisted files to the official preview', async () => {
    const { plugin, navigator, dom } = officeSetup();
    const event = fire(dom, 'dblclick', { target: navigator.elements.get('notes.md') });
    assert.equal(event.defaultPrevented, false);
    await settle(10);
    assert.deepEqual(dom.openCalls, []);
    plugin.teardown();
  });

  test('reports a failed system open without breaking the preview', async () => {
    const { plugin, navigator, dom } = officeSetup();
    plugin.remote.openOk = false;
    fire(dom, 'dblclick', { target: navigator.elements.get('report.xlsx') });
    await settle(10);
    assert.equal(dom.notifications.at(-1).message, '系统应用打开失败，已改为在预览中打开');
    plugin.teardown();
  });

  test('stays silent when the host cannot open workspace paths', async () => {
    const { plugin, navigator, dom } = officeSetup();
    plugin.remote.canOpen = false;
    fire(dom, 'dblclick', { target: navigator.elements.get('report.xlsx') });
    await settle(10);
    assert.deepEqual(dom.openCalls, []);
    assert.equal(dom.notifications.at(-1).message, '无法打开该文件');
    plugin.teardown();
  });
});

describe('teardown', () => {  test('removes listeners, the injected style and the find bar', () => {
    const { plugin, navigator, dom } = setup();
    const styleCount = dom.document.head.childNodes.length;
    assert.ok(styleCount > 0, 'the gesture style is injected');
    buildPreview(dom);
    fire(dom, 'keydown', { key: 'f', ctrlKey: true });
    plugin.teardown();
    assert.equal(dom.document.listeners.get('click')?.size ?? 0, 0);
    assert.equal(dom.document.querySelector('[data-files-plus-find]'), null);
    assert.equal(dom.document.head.childNodes.length, 0);
  });
});

describe('package manifest', () => {
  // A `require()` of a package that is not listed in `dsh.client.inject` fails
  // at runtime with no test-time signal, which is exactly how an icon binding
  // ships broken. Comparing the two lists catches that omission here.
  test('every package the client requires is declared in dsh.client.inject', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const source = readFileSync(join(root, 'client.js'), 'utf8');
    const declared = new Set(manifest.dsh.client.inject);
    const required = [...source.matchAll(/require\('([^']+)'\)/g)]
      .map(match => match[1])
      // React is the module-host global, never a package the profile resolves.
      .filter(id => id !== 'react' && id !== 'react/jsx-runtime');
    assert.ok(required.length > 0, 'the client requires at least one official package');
    for (const id of required) {
      assert.ok(declared.has(id), `"${id}" is required but missing from dsh.client.inject`);
    }
  });

  // Publishing gates: the marketplace listing rules and npm both reject the
  // local-only shape this package used to ship in. A regression here means the
  // next publish would fail, so the suite holds the line.
  test('the manifest is publishable: named, licensed, engine-scoped', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.ok(!manifest.name.startsWith('@local/'), 'the package name must not keep the local scope');
    assert.equal(manifest.private, undefined, 'a publishable package is not private');
    assert.match(manifest.name, /^dsh-[a-z0-9-]+$/, 'the name follows the dsh-plugin naming convention');
    assert.ok(manifest.license, 'a license must be declared');
    assert.ok(manifest.engines?.dsh, 'engines.dsh must declare the compatible DSH range');
    assert.ok(manifest.repository?.url, 'a repository url is required for the listing');
    assert.ok(manifest.homepage, 'a homepage is required for the listing');
    assert.ok(manifest.author, 'an author is required for the listing');
    assert.ok(existsSync(join(root, 'LICENSE')), 'the LICENSE file ships with the package');
    assert.ok(existsSync(join(root, 'README.md')), 'the README ships with the package');
    // The README must carry a copy-pasteable install command. Accept any spec
    // form the plugin manager actually parses (npm name, github:/gitlab:
    // shorthand, git URL, or absolute path), so the guard tracks the installed
    // resolver instead of hard-coding one distribution channel.
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    assert.match(
      readme,
      /dsh plugin add (?:[a-z0-9][a-z0-9._~-]*|(?:github|gitlab|bitbucket|gist):[^\s]+|git(?:\+[a-z]+)?:\/\/[^\s]+|[A-Za-z]:[\\/][^\s]+)/,
      'the README contains an install command the plugin manager can resolve',
    );
  });
});