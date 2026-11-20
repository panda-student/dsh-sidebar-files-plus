/**
 * dsh-sidebar-files-plus — companion plugin for the official workspace file tree.
 *
 * Phase 2: right-click selection (Windows convention — right-click selects the
 * row under the cursor, official plain-click behavior stays untouched), short
 * label reference chips into the composer through the official
 * `insertReference` channel, context-menu send action (copy-path and
 * open-with-system-app entries are left to the official plugins),
 * double-click-opens-system-app for office files, and a preview find bar
 * (Ctrl+F) over the loaded preview pages.
 *
 * Dragging rows to the composer is deliberately NOT implemented: the official
 * tree rows carry no `draggable` attribute, so the browser never starts an HTML5
 * drag and a `dragstart` listener could never fire. Right-click → send is the
 * supported path.
 *
 * Design rules:
 * - No official sources are modified; everything rides public extension points:
 *   `conversation.input.dock` (session slot carrying `inputActions`),
 *   `ctx.sessions.scope` → `conversation.input.for` (the `insertReference`
 *   facade), `ctx.contextMenus.register` (file/directory target families), and
 *   DOM gesture layering over `[data-files-body] [data-files-path]` rows.
 * - Selection state lives per navigator pane id; the official tree owns all
 *   rendering, we only paint a data attribute and read row metadata back.
 * - All copy flows through `ctx.locale` dictionaries; styles use `--dsw-alias-*`.
 *
 * The loader can only resolve table packages (`react`, official `@deepseek-ai/*`),
 * never this plugin's own files, so the whole client runs from this one file.
 * Structure is layered instead: pure helpers at the top (no DOM, no ctx), then
 * one factory per domain, then `apply` as the single orchestration point that
 * instantiates them and hands each only the dependencies it needs:
 *
 *   constants / locale dictionaries / STYLE_TEXT
 *   pure helpers        lastSegment, mentionOf, absOf, matcherFor, …
 *   createFindBar       preview find bar: element, matching, highlights
 *   createSelectionStore  per-pane selection state + mark painting
 *   rowInfoOf / focusIsEditable   shared DOM queries
 *   createGestureLayer  click / keyboard / context-menu handlers
 *   createSendPipeline  composer bridge, menus, send + system-app open
 *   apply               orchestration: create modules, inject slots, bind events
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-files-plus',
  factory(require) {
    const React = require('react');

    const NS = 'filesPlus';
    /** Icon key the send menu row names; bound to a component below. */
    const MENU_SEND_ICON = 'files-plus.send';

    const zh = {
      'menu.send': '发送到对话',
      'notify.sent': '已作为文件引用插入输入框',
      'notify.sendFailed': '输入框暂不可用，请确认会话已打开',
      'notify.openFallback': '系统应用打开失败，已改为在预览中打开',
      'notify.openFailed': '无法打开该文件',
      'find.title': '预览内容查找（仅搜索已加载部分）',
      'find.placeholder': '查找内容',
      'find.prev': '上一个（Shift+Enter）',
      'find.next': '下一个（Enter）',
      'find.close': '关闭（Esc）',
      'find.none': '无结果',
      'find.caseSensitive': '区分大小写（Alt+C）',
      'find.wholeWord': '全字匹配（Alt+W）',
      'find.regex': '使用正则表达式（Alt+R）',
    };
    const en = {
      'menu.send': 'Send to composer',
      'notify.sent': 'Inserted as file references into the composer',
      'notify.sendFailed': 'Composer unavailable; make sure the session is open',
      'notify.openFallback': 'System open failed; opened in the preview instead',
      'notify.openFailed': 'Cannot open this file',
      'find.title': 'Find in preview (searches loaded pages only)',
      'find.placeholder': 'Find',
      'find.prev': 'Previous (Shift+Enter)',
      'find.next': 'Next (Enter)',
      'find.close': 'Close (Esc)',
      'find.none': 'No matches',
      'find.caseSensitive': 'Match case (Alt+C)',
      'find.wholeWord': 'Match whole word (Alt+W)',
      'find.regex': 'Use regular expression (Alt+R)',
    };

    const PREF_KEY = 'filesPlus.gestures';
    const DEFAULT_PREFS = Object.freeze({
      officeOpen: true,
      officeExts: 'doc docx xls xlsx ppt pptx pdf wps et dps',
    });

    // =====================================================================
    // Pure helpers. No DOM, no ctx, no state: given the same input they return
    // the same output, so they can be reasoned about (and tested) on their own.
    // =====================================================================

    /** Last path segment, falling back to the whole path for a bare root. */
    function lastSegment(path) {
      return path.split('/').pop() || path;
    }

    /** Workspace-relative path → the `@`-mention text the composer understands. */
    function mentionOf(relativePath, kind) {
      if (relativePath === '') return '@';
      const tail = kind === 'directory' ? '/' : '';
      return /\s/.test(relativePath) ? `@"${relativePath}${tail}"` : `@${relativePath}${tail}`;
    }

    /** Join a navigator root and a relative path with a single separator. */
    function absOf(root, relativePath) {
      if (relativePath === '') return root;
      return `${root.replace(/[\\/]+$/, '')}/${relativePath}`;
    }

    /** Split the stored extension list into lower-case extensions. */
    function parseExtensions(spec) {
      return spec.toLowerCase().split(/[\s,;，；]+/).filter(Boolean);
    }

    /** Does this file name carry an extension from the list? */
    function hasExtension(name, extensions) {
      const dot = name.lastIndexOf('.');
      if (dot <= 0) return false;
      return extensions.includes(name.slice(dot + 1).toLowerCase());
    }

    /** Whether a character can be part of a word (whole-word matching). */
    function isWordChar(char) {
      return char !== undefined && /[\w$\u0080-\uFFFF]/u.test(char);
    }

    /**
     * Build a matcher for `term` from the active switches.
     *
     * Returns `undefined` for an unusable pattern (empty term, or a regex the
     * user is still typing) so callers show "no matches" instead of throwing on
     * every keystroke.
     */
    function matcherFor(term, options) {
      if (term === '') return undefined;
      const flags = options.caseSensitive ? 'g' : 'gi';
      if (options.regex) {
        let pattern;
        try {
          pattern = new RegExp(term, flags);
        } catch {
          return undefined; // half-typed regex: no matches until it parses
        }
        return (text) => {
          pattern.lastIndex = 0;
          const found = [];
          for (let hit = pattern.exec(text); hit !== null; hit = pattern.exec(text)) {
            // A zero-length match would loop forever; step past it.
            if (hit[0] === '') {
              pattern.lastIndex += 1;
              if (pattern.lastIndex > text.length) break;
              continue;
            }
            // The whole-word switch stacks with regex mode, so a hit touching a
            // word character on either side is dropped.
            if (options.wholeWord
              && (isWordChar(text[hit.index - 1]) || isWordChar(text[hit.index + hit[0].length]))) {
              continue;
            }
            found.push({ start: hit.index, end: hit.index + hit[0].length });
          }
          return found;
        };
      }
      const needle = options.caseSensitive ? term : term.toLowerCase();
      return (text) => {
        const hay = options.caseSensitive ? text : text.toLowerCase();
        const found = [];
        let index = hay.indexOf(needle);
        while (index !== -1) {
          if (!options.wholeWord
            || (!isWordChar(hay[index - 1]) && !isWordChar(hay[index + needle.length]))) {
            found.push({ start: index, end: index + needle.length });
          }
          index = hay.indexOf(needle, index + needle.length);
        }
        return found;
      };
    }

    /** Read a JSON preference, falling back to `fallback` on any failure. */
    function readStoredPreferences(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
      } catch {
        return { ...fallback }; // corrupted or unavailable storage
      }
    }

    /** Persist preferences, ignoring storage failures. */
    function writeStoredPreferences(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch { /* storage unavailable: the session keeps the in-memory value */ }
    }

    const STYLE_TEXT = `
[data-files-body] [data-files-path][data-files-plus-selected="1"] > div > button {
  background: var(--dsw-alias-interactive-bg-active);
}
[data-files-body] [data-files-path][data-files-plus-selected="1"] > div > button:hover {
  background: var(--dsw-alias-interactive-bg-active);
}
[data-files-plus-find] {
  position: fixed;
  z-index: 1200;
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg, 12px);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
}
[data-files-plus-find][hidden] { display: none; }
[data-files-plus-find] .fsp-term {
  width: 200px;
  padding: 3px 8px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md, 8px);
}
[data-files-plus-find] .fsp-count {
  min-width: 48px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
[data-files-plus-find] button.fsp-nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  font: inherit;
  line-height: 1;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  cursor: pointer;
}
[data-files-plus-find] button.fsp-nav:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-files-plus-find] button.fsp-toggle {
  min-width: 24px;
  height: 24px;
  padding: 0 4px;
  font: inherit;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px);
  cursor: pointer;
}
[data-files-plus-find] button.fsp-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-files-plus-find] button.fsp-toggle[data-on="1"] {
  color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-active);
  border-color: var(--dsw-alias-brand-primary);
}
::highlight(files-plus-find) {
  background-color: rgba(255, 213, 0, 0.4);
}
::highlight(files-plus-find-current) {
  background-color: rgba(255, 149, 0, 0.85);
  color: #1a1a1a;
}
`;

    /**
     * The send pipeline: the composer bridge dock, the session lookup, the
     * system-app open, entry resolution for a clicked row (the whole selection
     * when the row belongs to it), the send itself with per-entry chip
     * insertion, and the context-menu registrations that expose it.
     *
     * All DSH services arrive via `ctx`; the store supplies menu target
     * resolution so this pipeline and the gesture layer share one selection.
     */
    function createSendPipeline(ctx, t, store) {
      const composers = new Map(); // sessionId -> InputActions
      // The row the most recent context menu was opened on. Directory sends
      // resolve their target pane from it because the official directory menu
      // target carries no pane id.
      let lastRowContext = null;

      /** Session slot component that registers its composer with the bridge. */
      function SendBridgeDock(props) {
        const { sessionId, inputActions } = props;
        React.useEffect(() => {
          composers.set(sessionId, inputActions);
          return () => { if (composers.get(sessionId) === inputActions) composers.delete(sessionId); };
        }, [sessionId, inputActions]);
        return null;
      }

      function sessionForRoot(root) {
        if (!root) return undefined;
        let fallback;
        for (const row of Object.values(ctx.sessions.list.getSnapshot().byId)) {
          if (row.cwd !== root) continue;
          if ((row.retainedBy?.mainView ?? 0) > 0) return row.sessionId;
          fallback ??= row.sessionId;
        }
        return fallback;
      }

      /**
       * Open an absolute workspace path with the system app through the remote
       * bridge. Reports through the same notification channel as the menus.
       */
      async function openInSystemApp(sessionId, absolutePath) {
        try {
          const can = await ctx.remote.session.canOpenWorkspacePath();
          if (!can.ok || can.value !== true) {
            ctx.contextMenus.notify(t('notify.openFailed'), false);
            return;
          }
          const result = await ctx.remote.session.openWorkspacePath({ path: absolutePath });
          // The preview tab is already open from the single click, so a failure
          // here only reports; the user still has the in-app view.
          if (!result.ok) ctx.contextMenus.notify(t('notify.openFallback'), false);
        } catch {
          ctx.contextMenus.notify(t('notify.openFailed'), false);
        }
      }

      /**
       * The per-session input facade (SessionInput face, carrying
       * `insertReference` — the short-label chip channel). Same resolution the
       * official queue dock uses. Undefined when the session scope or the
       * conversation service is gone; callers fall back to plain text.
       */
      function sessionInputOf(sessionId) {
        if (sessionId === undefined) return undefined;
        try {
          const actx = ctx.sessions.scope(sessionId);
          if (actx === undefined) return undefined;
          const conversation = actx.get('conversation');
          if (conversation === undefined) return undefined;
          return conversation.input.for(actx);
        } catch {
          return undefined;
        }
      }

      function rowKindOf(paneId, path) {
        const nav = document.querySelector(`[data-files-navigator="${CSS.escape(paneId)}"]`);
        const row = nav?.querySelector(`[data-files-path="${CSS.escape(path)}"]`);
        return row?.getAttribute('data-files-entry') || 'file';
      }

      /** Selection entries when the clicked row is part of the selection, else just that row. */
      function targetEntries(kind, target, paneId) {
        const selection = paneId !== undefined ? store.peek(paneId) : undefined;
        if (selection !== undefined && selection.paths.has(target.path)) {
          return [...selection.paths].map(path => ({ path, kind: rowKindOf(paneId, path) }));
        }
        return [{ path: target.path, kind }];
      }

      /**
       * Insert one short-label reference chip per entry (official
       * ReferenceInsert: the chip shows the path's last segment, the sent text
       * is the full @mention). Falls back to plain-text insertion per entry when
       * the chip channel is unavailable (older facade, claimed phase, revision
       * race).
       */
      async function sendEntries(sessionId, entries) {
        const actions = sessionId !== undefined ? composers.get(sessionId) : undefined;
        if (actions === undefined) {
          ctx.contextMenus.notify(t('notify.sendFailed'), false);
          return;
        }
        const facade = sessionInputOf(sessionId);
        let inserted = 0;
        for (const entry of entries) {
          const mention = mentionOf(entry.path, entry.kind);
          const span = actions.captureInsertion();
          let applied = false;
          if (facade !== undefined && span !== null && span !== undefined) {
            applied = facade.insertReference({
              source: 'reference',
              ref: mention,
              label: lastSegment(entry.path),
              appearance: entry.kind === 'directory' ? 'folder' : 'file',
              clipboardText: mention,
            }, span);
          }
          if (!applied) applied = actions.insertText(`${mention} `, span);
          if (applied) inserted++;
        }
        ctx.contextMenus.notify(inserted > 0 ? t('notify.sent') : t('notify.sendFailed'), inserted > 0);
      }

      /**
       * Register the two context-menu contributions (file and directory target
       * families) and the icon that decorates them. Must run inside `apply` so
       * the caller's `ctx.effect` wrapping handles disposal.
       */
      function registerMenus() {
        // Copy-path menu entries are intentionally NOT registered: the official
        // open-in-app plugin already provides 复制文件路径/复制文件夹路径 for
        // both target families.
        ctx.effect(() => ctx.contextMenus.register({
          id: 'files-plus.send', target: 'file', order: 60,
          resolve: (target) => [{
            id: 'files-plus.send', label: t('menu.send'), icon: { key: MENU_SEND_ICON },
            run: () => sendEntries(target.sessionId, targetEntries('file', target, target.paneId)),
          }],
        }), 'files-plus: file send menu');
        ctx.effect(() => ctx.contextMenus.register({
          id: 'files-plus.send', target: 'directory', order: 60,
          resolve: (target) => [{
            id: 'files-plus.send', label: t('menu.send'), icon: { key: MENU_SEND_ICON },
            run: () => sendEntries(target.sessionId, targetEntries('directory', target, lastRowContext?.paneId)),
          }],
        }), 'files-plus: directory send menu');
        // The menu row renders whatever `icon.key` names; binding the official
        // send glyph keeps the entry visually in line with the neighbouring
        // open-in-app items instead of standing out as the only iconless row.
        // The icon is read once at apply time, like the official plugins do, so
        // a missing package fails loudly here rather than inside a render.
        const SendIcon = require('@deepseek-ai/dsh-client-ui-primitives').IconSendOutlineRegular;
        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon', key: MENU_SEND_ICON,
        }, () => React.createElement(SendIcon)));
      }

      /** Record the row a context menu was opened on (menu resolution reads it). */
      function setRowContext(info) { lastRowContext = info; }

      return {
        /** Session-slot dock component; inject on `conversation.input.dock`. */
        SendBridgeDock,
        sessionForRoot,
        openInSystemApp,
        registerMenus,
        setRowContext,
      };
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'files-plus: dictionaries');
      const t = ctx.locale.bind(NS);

      // ---------- gesture preferences (browser storage, instant effect) ----------
      // The floating bar and its settings popover are gone; the stored
      // double-click whitelist still governs the double-click gesture.
      const prefs = readStoredPreferences(PREF_KEY, DEFAULT_PREFS);
      const isOfficeFile = name => prefs.officeOpen
        && hasExtension(name, parseExtensions(prefs.officeExts));

      // Selection state and marks live in a dedicated store; every layer below
      // (menus, gestures) drives it through this one object.
      const store = createSelectionStore();

      // ---------- orchestration: wire the domain modules together ----------
      const pipeline = createSendPipeline(ctx, t, store);
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'files-plus-bridge', order: 95,
      }, pipeline.SendBridgeDock));
      pipeline.registerMenus();

      // ---------- gestures, selection painting and the preview find bar ----------
      ctx.effect(() => {
        const style = document.createElement('style');
        style.textContent = STYLE_TEXT;
        document.head.appendChild(style);

        const findBar = createFindBar(t);
        const paint = () => store.paint();
        const schedulePaint = () => store.schedulePaint();

        const gestures = createGestureLayer({
          store, findBar, t,
          // Wrapped so the service method keeps its receiver when called from
          // inside the gesture layer.
          notify: (...args) => ctx.contextMenus.notify(...args),
          isOfficeFile,
          sessionForRoot: pipeline.sessionForRoot,
          openInSystemApp: pipeline.openInSystemApp,
          onRowContext: pipeline.setRowContext,
        });
        // NOTE: paste-to-composer is intentionally NOT intercepted here — the
        // official composer already runs a global paste handler that routes
        // pasted text (including absolute workspace paths) into the draft, and
        // a second handler would double-insert. Verified live 2026-11-19.
        const observer = new MutationObserver(() => {
          // Official re-renders replace row nodes and wipe the marks, so a
          // mutation must be answered — but coalesced. A streaming reply emits
          // hundreds of mutations per second, and painting inline on each one
          // rescanned every visible tree row for no visible gain.
          schedulePaint();
          // The preview may have been closed: drop the bar rather than leave it
          // floating over whatever replaced the preview.
          if (findBar.isOpen() && !findBar.hasVisiblePreview()) findBar.close();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const onWindowResize = () => findBar.reposition();
        window.addEventListener('resize', onWindowResize);

        document.addEventListener('click', gestures.onClick, true);
        document.addEventListener('dblclick', gestures.onDoubleClick, true);
        document.addEventListener('keydown', gestures.onKeyDown, true);
        document.addEventListener('contextmenu', gestures.onContextMenu, true);
        paint();

        return () => {
          observer.disconnect();
          document.removeEventListener('click', gestures.onClick, true);
          document.removeEventListener('dblclick', gestures.onDoubleClick, true);
          document.removeEventListener('keydown', gestures.onKeyDown, true);
          document.removeEventListener('contextmenu', gestures.onContextMenu, true);
          findBar.dispose();
          window.removeEventListener('resize', onWindowResize);
          style.remove();
        };
      }, 'files-plus: gestures');
    }


    /**
     * The gesture layer: click, keyboard and context-menu handling over the
     * official file tree.
     *
     * Dependencies arrive as one object so this factory has no hidden ties to
     * `apply`: the selection store it drives, the find bar it opens, the helpers
     * it consults (office-file rule, session lookup, system-app open), the
     * notification service, and the hook that records the row a context menu was
     * opened on (menus read it back to resolve directory sends).
     */
    function createGestureLayer(deps) {
      const { store, findBar, t, notify, isOfficeFile, sessionForRoot, openInSystemApp, onRowContext } = deps;
      const paint = () => store.paint();
      const selectionOf = paneId => store.selectionOf(paneId);

      // The owning pane of the last row interaction, recorded on click and
      // contextmenu. Ctrl+A consults this instead of a document-wide
      // `pointerover` listener: that listener ran a selector match on EVERY
      // mouse move anywhere in the app to serve one rare shortcut, which is a
      // poor trade. A click is what gives a pane its selection anyway, so the
      // recorded value is the pane the user is actually working in.
      let lastPointerNav = null;
      const rememberNav = (target) => {
        lastPointerNav = target instanceof Element ? target.closest('[data-files-navigator]') : null;
      };

      const onClick = (event) => {
        const info = rowInfoOf(event.target);
        rememberNav(event.target);
        if (info === null) {
          // A plain click inside the navigator but off the rows clears the
          // pane's selection; modifier clicks never clear.
          if (!event.shiftKey && !event.ctrlKey && !event.metaKey
            && event.target instanceof Element) {
            const nav = event.target.closest('[data-files-navigator]');
            const selection = nav !== null ? store.peek(nav.getAttribute('data-files-navigator') || '') : undefined;
            if (selection !== undefined && selection.paths.size > 0) {
              store.clearSelection(selection);
              paint();
            }
          }
          return;
        }
        if (event.detail === 0) return; // keyboard-generated click: official behavior only
        const selection = selectionOf(info.paneId);
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
          // Plain click restores the official click behavior (preview for
          // files, expansion for directories); it only clears a stale
          // selection so right-click actions can't act on a stale group.
          if (selection.paths.size > 0) {
            store.clearSelection(selection);
            paint();
          }
          return;
        }
        // Modifier clicks own the gesture: the official open/toggle is suppressed.
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          const rows = [...info.body.querySelectorAll('[data-files-path]')]
            .map(row => row.getAttribute('data-files-path'));
          const anchor = selection.anchor ?? info.path;
          const from = rows.indexOf(anchor);
          const to = rows.indexOf(info.path);
          if (from >= 0 && to >= 0) {
            selection.paths.clear();
            for (let index = Math.min(from, to); index <= Math.max(from, to); index++) {
              selection.paths.add(rows[index]);
            }
          } else {
            selection.paths.add(info.path);
          }
        } else if (selection.paths.has(info.path)) {
          selection.paths.delete(info.path);
        } else {
          selection.paths.add(info.path);
          selection.anchor = info.path;
        }
        paint();
      };

      const onKeyDown = (event) => {
        if (findBar.contains(event.target)) return;
        if (event.ctrlKey || event.metaKey) {
          const key = event.key.toLowerCase();
          if (key === 'f' && !event.shiftKey && !event.altKey) {
            // Take over only when a preview is visible; otherwise the web
            // GUI's browser find stays untouched.
            if (findBar.hasVisiblePreview()) {
              event.preventDefault();
              event.stopPropagation();
              findBar.open();
            }
            return;
          }
          if (key === 'a' && !event.shiftKey && !event.altKey) {
            // Ctrl/Meta+A selects all rows in the pane the user last worked
            // in; editable focuses and elsewhere-typing contexts are untouched
            // so the composer keeps its own select-all.
            if (focusIsEditable()) return;
            const active = document.activeElement;
            const nav = lastPointerNav ?? (active instanceof Element ? active.closest('[data-files-navigator]') : null);
            if (nav === null || !nav.isConnected) return;
            const paneId = nav.getAttribute('data-files-navigator') || '';
            if (paneId === '') return;
            const selection = selectionOf(paneId);
            for (const row of nav.querySelectorAll('[data-files-body] [data-files-path]')) {
              selection.paths.add(row.getAttribute('data-files-path'));
            }
            event.preventDefault();
            event.stopPropagation();
            paint();
          }
        }
      };

      const onDoubleClick = (event) => {
        const info = rowInfoOf(event.target);
        if (info === null || info.kind !== 'file' || !isOfficeFile(info.name)) return;
        event.preventDefault();
        event.stopPropagation();
        const sessionId = sessionForRoot(info.root);
        if (sessionId === undefined) {
          notify(t('notify.openFailed'), false);
          return;
        }
        void openInSystemApp(sessionId, absOf(info.root, info.path));
      };

      const onContextMenu = (event) => {
        const info = rowInfoOf(event.target);
        onRowContext(info);
        rememberNav(event.target);
        if (info === null) return;
        // Right-click selects (Windows convention): a row outside the current
        // selection becomes the sole selection; a row inside it keeps the
        // group, so the menu acts on the whole selection.
        const selection = selectionOf(info.paneId);
        if (!selection.paths.has(info.path)) {
          selection.paths.clear();
          selection.paths.add(info.path);
          selection.anchor = info.path;
          paint();
        }
      };

      return { onClick, onKeyDown, onDoubleClick, onContextMenu };
    }

    /**
     * Read the row under a pointer target.
     *
     * The official tree owns rendering, so all this plugin knows about a row is
     * what the DOM says: the path it carries, its kind, and the navigator pane it
     * belongs to. Returns `null` for anything that is not inside a row.
     */
    function rowInfoOf(target) {
      if (!(target instanceof Element)) return null;
      const row = target.closest('[data-files-path]');
      const body = target.closest('[data-files-body]');
      const nav = target.closest('[data-files-navigator]');
      if (row === null || body === null || nav === null) return null;
      const path = row.getAttribute('data-files-path') || '';
      return {
        paneId: nav.getAttribute('data-files-navigator') || '',
        root: nav.getAttribute('data-files-root') || '',
        path,
        kind: row.getAttribute('data-files-entry') || 'file',
        name: lastSegment(path),
        body,
      };
    }

    /**
     * Selection state and its on-screen marks, one bucket per navigator pane.
     *
     * Cost is the design constraint. A naive repaint walks every row in the pane,
     * which made a single folder click cost time proportional to the whole tree
     * (50 ms at 4000 rows) even though the user had marked only a handful. Two
     * rules keep the work proportional to what is selected:
     *
     * 1. Rows this store marked are remembered in `marked`, so clearing a
     *    selection touches exactly those nodes.
     * 2. A pane with nothing selected and nothing marked is skipped before any
     *    query runs.
     *
     * A full scan still happens when rows must be *found* — a selection that
     * outlives a re-render, or a fresh range select — because the official tree
     * gives no path→element index to consult.
     */
    function createSelectionStore() {
      // paneId -> { paths: Set<string>, anchor: string | null, marked: Element[] }
      const panes = new Map();
      let paintScheduled = false;

      function selectionOf(paneId) {
        let selection = panes.get(paneId);
        if (selection === undefined) {
          selection = { paths: new Set(), anchor: null, marked: [] };
          panes.set(paneId, selection);
        }
        return selection;
      }

      function isMarked(row, selection) {
        return row.isConnected
          && row.getAttribute('data-files-plus-selected') === '1'
          && selection.paths.has(row.getAttribute('data-files-path'));
      }

      function unmark(row) {
        if (row.getAttribute('data-files-plus-selected') === '1') row.removeAttribute('data-files-plus-selected');
      }

      /** Repaint the selected-row marks for every pane. */
      function paint() {
        paintScheduled = false;
        for (const [paneId, selection] of panes) {
          const marked = selection.marked;
          if (selection.paths.size === 0) {
            // Nothing selected: unmark exactly what this store marked. This is
            // the path a plain click on a folder takes, and it needs no pane
            // lookup and no row scan at all.
            if (marked.length === 0) continue;
            for (const row of marked) if (row.isConnected) unmark(row);
            marked.length = 0;
            continue;
          }
          // Already painted and unchanged: nothing to do. Both checks matter —
          // the attribute check catches a re-render that kept the node but wiped
          // its attributes, the path check catches a same-size selection that
          // moved to other rows.
          if (marked.length === selection.paths.size && marked.every(row => isMarked(row, selection))) continue;
          const nav = document.querySelector(`[data-files-navigator="${CSS.escape(paneId)}"]`);
          if (nav === null) continue;
          // Clear old marks before rescanning: a row may have been removed (folder
          // collapsed) or replaced (re-render), and a detached node is invisible
          // to the scan below, so it would otherwise keep a stale mark forever.
          for (const row of marked) unmark(row);
          marked.length = 0;
          for (const row of nav.querySelectorAll('[data-files-path]')) {
            const want = selection.paths.has(row.getAttribute('data-files-path'));
            if (want !== (row.getAttribute('data-files-plus-selected') === '1')) {
              if (want) row.setAttribute('data-files-plus-selected', '1');
              else unmark(row);
            }
            if (want) marked.push(row);
          }
        }
      }

      /**
       * Ask for a repaint on the next microtask instead of right now. Official
       * re-renders replace row nodes and wipe the marks, so a mutation must still
       * be answered — but once per burst, not once per mutation.
       */
      function schedulePaint() {
        if (paintScheduled) return;
        paintScheduled = true;
        queueMicrotask(() => { if (paintScheduled) paint(); });
      }

      function clearSelection(selection) {
        selection.paths.clear();
        selection.anchor = null;
      }

      return {
        selectionOf,
        paint,
        schedulePaint,
        clearSelection,
        /** The pane's selection, if it has ever been used. */
        peek: paneId => panes.get(paneId),
      };
    }

    /** A focus that owns Ctrl+A itself (typing surfaces). */
    function focusIsEditable() {
      const active = document.activeElement;
      return active !== null
        && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable === true);
    }

    /**
     * The preview find bar (Ctrl+F).
     *
     * The desktop shell has no find-in-page and the preview has no built-in
     * search, so Ctrl+F does nothing there; the web GUI's browser find works but
     * only over the whole page. This bar scopes to the visible preview content
     * (`[data-textpreview-content]`), highlights matches with custom highlights
     * (no DOM mutation — safe against React re-renders), and only sees pages the
     * paged-text renderers have loaded so far.
     *
     * Owns its element, its debounce and its persisted switches; the host only
     * opens, closes and repositions it.
     */
    function createFindBar(t) {
      // VS Code-style matching switches, persisted per user.
      const FIND_PREF_KEY = 'filesPlus.find';
      const FIND_DEFAULTS = Object.freeze({ caseSensitive: false, wholeWord: false, regex: false });
      // Horizontal room kept free on the right edge of the preview content so
      // CodeBlock's own copy button is never covered by the find bar. The overlay
      // is fixed-position, so this is measured from the content's right edge.
      const COPY_BUTTON_CLEARANCE = 48;

      const findOptions = readStoredPreferences(FIND_PREF_KEY, FIND_DEFAULTS);
      let bar = null;
      let termInput = null;
      let countEl = null;
      let debounce = 0;
      let lastMatch = null; // { node, start } of the currently highlighted match
      let observedFrame = null;
      // Anchors to the visible preview content's top-right corner (viewport
      // coordinates), not the window corner — that sits under the title bar.
      const frameResize = new ResizeObserver(() => position());

      function visiblePreviewContent() {
        for (const frame of document.querySelectorAll('[data-textpreview-content]')) {
          const rect = frame.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return frame;
        }
        return null;
      }

      function position() {
        if (bar === null || bar.hidden === true) return;
        const frame = visiblePreviewContent();
        if (frame === null) {
          close();
          return;
        }
        if (observedFrame !== frame) {
          if (observedFrame !== null) frameResize.unobserve(observedFrame);
          frameResize.observe(frame);
          observedFrame = frame;
        }
        const rect = frame.getBoundingClientRect();
        bar.style.top = `${Math.max(8, rect.top + 8)}px`;
        // Keep clear of the preview's own copy button so it stays clickable.
        bar.style.right = `${Math.max(8, window.innerWidth - rect.right + COPY_BUTTON_CLEARANCE)}px`;
      }

      function collectMatches(term) {
        const container = visiblePreviewContent();
        const matches = [];
        if (container === null) return matches;
        const match = matcherFor(term, findOptions);
        if (match === undefined) return matches;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const text = node.nodeValue ?? '';
          if (text === '') continue;
          for (const span of match(text)) matches.push({ node, start: span.start, end: span.end });
        }
        return matches;
      }

      /**
       * Paint every match with a custom highlight and mark the current one.
       * Highlighting NEVER touches the document selection: `getSelection` +
       * `addRange` moves focus out of the find input (and the app then routes
       * keyboard focus to the preview), which made typing jump into the
       * document. Custom highlights are painting only, so the caret stays put.
       */
      function paintMatches(matches, current) {
        if (!('highlights' in CSS)) return;
        const all = [];
        for (const match of matches) {
          try {
            const range = document.createRange();
            range.setStart(match.node, match.start);
            range.setEnd(match.node, match.end);
            all.push(range);
          } catch { /* node replaced by a re-render: next pass re-collects */ }
        }
        if (all.length === 0) {
          CSS.highlights.delete('files-plus-find');
          CSS.highlights.delete('files-plus-find-current');
          return;
        }
        CSS.highlights.set('files-plus-find', new Highlight(...all));
        const activeRange = current === null ? undefined : all[current];
        if (activeRange === undefined) CSS.highlights.delete('files-plus-find-current');
        else CSS.highlights.set('files-plus-find-current', new Highlight(activeRange));
      }

      /**
       * The element that actually scrolls the preview body.
       *
       * `[data-textpreview-content]` is only the content ROW of the preview
       * frame; the scrolling element lives INSIDE it, and which one it is
       * depends on the renderer (the official `scrollToLine` switches on the
       * same distinction): plain text scrolls `[data-textpreview-body]`, the
       * highlighted code renderer scrolls its own `[data-code-block-content]`
       * viewport. Searching upwards from the content row never finds a scroller
       * at all, which is why navigation moved the counter without the document.
       */
      function scrollerOf(container) {
        const inner = container.querySelector('[data-code-block-content]')
          ?? container.querySelector('[data-textpreview-body]');
        if (inner !== null) return inner;
        // Unknown renderer: fall back to any scrollable descendant, then to the
        // content row itself.
        for (const candidate of container.querySelectorAll('*')) {
          const overflow = getComputedStyle(candidate).overflowY;
          if (overflow === 'auto' || overflow === 'scroll') return candidate;
        }
        return container;
      }

      /**
       * Bring one match into view without touching focus or the selection.
       * Scrolling is assigned on the container directly: `scrollIntoView` can
       * also steal focus.
       */
      function scrollToMatch(node) {
        const container = visiblePreviewContent();
        if (container === null) return;
        const scroller = scrollerOf(container);
        if (scroller === null || !scroller.contains(node)) return;
        const range = document.createRange();
        const text = node.nodeValue ?? '';
        range.setStart(node, 0);
        range.setEnd(node, text.length);
        const rect = range.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        // Already fully visible: leave the reader's scroll position alone.
        if (rect.top >= box.top && rect.bottom <= box.bottom) return;
        // Centre the match, then clamp: some renderers report rectangles from a
        // container whose origin is not the scrollport.
        const delta = rect.top - box.top - box.height / 2 + rect.height / 2;
        const next = scroller.scrollTop + delta;
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = Math.min(Math.max(0, next), max);
      }

      function updateCount(current, total, term) {
        countEl.textContent = term === '' ? '' : total === 0 ? t('find.none') : `${current}/${total}`;
      }

      /** Show the match `direction` steps from the current one, wrapping. */
      function navigate(direction) {
        const term = termInput.value.trim();
        const matches = term === '' || visiblePreviewContent() === null ? [] : collectMatches(term);
        if (matches.length === 0) {
          lastMatch = null;
          paintMatches([], null);
          updateCount(1, 0, term);
          return;
        }
        let index = matches.findIndex(match => match.node === lastMatch?.node && match.start === lastMatch?.start);
        if (index === -1) index = direction > 0 ? -1 : 0;
        index = (index + direction + matches.length) % matches.length;
        const match = matches[index];
        lastMatch = { node: match.node, start: match.start };
        paintMatches(matches, index);
        scrollToMatch(match.node);
        updateCount(index + 1, matches.length, term);
      }

      /** One navigation button: prev, next or close. */
      function navButton(label, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'fsp-nav';
        button.textContent = action === 'prev' ? '↑' : action === 'next' ? '↓' : '✕';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          if (action === 'close') close();
          else navigate(action === 'prev' ? -1 : 1);
        });
        return button;
      }

      /**
       * One matching switch (Aa / ab / .*). `altKey` mirrors VS Code's own
       * accelerator (Alt+C / Alt+W / Alt+R) while the caret is in the box.
       */
      function toggleButton(text, key, label, altKey) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'fsp-toggle';
        button.textContent = text;
        button.dataset.opt = key;
        button.dataset.alt = altKey;
        button.title = label;
        button.setAttribute('aria-label', label);
        const sync = () => {
          const on = findOptions[key] === true;
          if (button.getAttribute('aria-pressed') !== String(on)) button.setAttribute('aria-pressed', String(on));
          button.dataset.on = on ? '1' : '0';
        };
        sync();
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          findOptions[key] = findOptions[key] !== true;
          writeStoredPreferences(FIND_PREF_KEY, findOptions);
          sync();
          lastMatch = null;
          navigate(1);
          termInput.focus();
        });
        return { button, sync };
      }

      function build() {
        bar = document.createElement('div');
        bar.setAttribute('data-files-plus-find', '');
        bar.hidden = true;

        termInput = document.createElement('input');
        termInput.className = 'fsp-term';
        termInput.type = 'text';
        termInput.placeholder = t('find.placeholder');
        termInput.title = t('find.title');
        termInput.spellcheck = false;

        countEl = document.createElement('span');
        countEl.className = 'fsp-count';

        termInput.addEventListener('input', () => {
          window.clearTimeout(debounce);
          debounce = window.setTimeout(() => {
            lastMatch = null;
            navigate(1);
            // Belt and braces: nothing in the highlight path touches focus, but
            // if another handler moved it, keep the caret in the box.
            if (bar !== null && bar.hidden === false && document.activeElement !== termInput) {
              termInput.focus();
            }
          }, 150);
        });
        termInput.addEventListener('keydown', (event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            navigate(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        });

        const toggles = [
          toggleButton('Aa', 'caseSensitive', t('find.caseSensitive'), 'c'),
          toggleButton('ab', 'wholeWord', t('find.wholeWord'), 'w'),
          toggleButton('.*', 'regex', t('find.regex'), 'r'),
        ];
        // Alt accelerators while the caret is in the find box (VS Code parity).
        termInput.addEventListener('keydown', (event) => {
          if (!event.altKey) return;
          const key = event.key.toLowerCase();
          const target = toggles.find(toggle => toggle.button.dataset.alt === key);
          if (target === undefined) return;
          event.preventDefault();
          target.button.click();
        });

        bar.append(termInput, countEl,
          ...toggles.map(toggle => toggle.button),
          navButton(t('find.prev'), 'prev'), navButton(t('find.next'), 'next'), navButton(t('find.close'), 'close'));
        document.body.appendChild(bar);
      }

      function open() {
        if (bar === null) build();
        bar.hidden = false;
        position();
        termInput.focus();
        termInput.select();
        navigate(1);
      }

      function close() {
        window.clearTimeout(debounce);
        if (bar !== null) bar.hidden = true;
        lastMatch = null;
        paintMatches([], null);
      }

      return {
        open,
        close,
        /** Reposition after a window resize; a no-op while hidden. */
        reposition: position,
        /** Whether focus currently sits inside the bar. */
        contains: node => bar !== null && node instanceof Node && bar.contains(node),
        /** Drop the element and stop observing; called on teardown. */
        dispose() {
          window.clearTimeout(debounce);
          frameResize.disconnect();
          observedFrame = null;
          bar?.remove();
          bar = null;
        },
        /** Let the host re-check that a preview is still on screen. */
        hasVisiblePreview: () => visiblePreviewContent() !== null,
        isOpen: () => bar !== null && bar.hidden === false,
      };
    }

    return {
      inject: ['slots', 'locale', 'contextMenus', 'sessions', 'remote', 'remote.session'],
      apply,
    };
  },
});
;
//# sourceMappingURL=??dsh-sidebar-files-plus/client.js.map&rev=5c8d0adc1222