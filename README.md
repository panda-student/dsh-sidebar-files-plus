# dsh-sidebar-files-plus

[中文](#功能) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that upgrades the workspace **file tree**: Windows-style right-click multi-select, sending the selection to the composer as official reference chips, double-click opens office files with the system app, and a Ctrl+F find bar over loaded preview pages.

**In one sentence:** after installing, you can select many files with right-click / Shift / Ctrl / Ctrl+A, send them all to the conversation in one menu action, open office documents with a double-click, and press Ctrl+F to search inside the code or text preview.

![Icon](icon.svg)

## Features

- **Right-click selects** (Windows convention): a row outside the current selection becomes the selection; a row inside keeps the group, so the menu acts on the whole selection.
- **Modifier clicks**: Shift = range select from the anchor, Ctrl/Cmd = toggle one row, Ctrl+A = select all rows of the pane you last worked in (the composer's own select-all is untouched).
- **Send to composer**: one context-menu entry inserts one official short-label reference chip per selected file or folder (falls back to plain `@mentions` when the chip channel is unavailable).
- **Double-click office files** (doc/docx/xls/xlsx/ppt/pptx/pdf/wps/et/dps) opens them with the system app; the preview tab stays open.
- **Ctrl+F find bar** for the preview: case / whole-word / regex toggles (VS Code style, Alt+C/W/R), match counting, Enter/Shift+Enter navigation, scrolling to the active match without stealing focus (Custom Highlight API — the document selection is never touched).

## Install

From npm:

```sh
dsh plugin add dsh-sidebar-files-plus
```

Or straight from the repository:

```sh
dsh plugin add github:panda-student/dsh-sidebar-files-plus
```

Both are install specs the plugin manager parses (`@deepseek-ai/dsh-plugin-manager/install-spec`), so neither needs a local checkout. You can also add the directory itself with **Plugins → Add plugin**.

Requires DeepSeek Harness `>=0.2.2-rc.1` (desktop or web profile; the plugin only extends the Web client).

## Usage

1. Open a workspace, click a folder in the left file tree.
2. Right-click a row → it becomes selected; Shift+click extends the range; Ctrl+click toggles rows.
3. Right-click any selected row → **Send to composer** puts one chip per file into the input box.
4. Open a code or text file in the preview → press **Ctrl+F** to search the loaded pages.

## Permissions and data flow

- The plugin runs **entirely inside the app**. It adds DOM listeners over the official file tree, registers a context-menu entry, a preview find bar, and a session dock that remembers the composer input actions.
- No network requests, no telemetry, no data leaves the machine.
- Opening a file with the system app goes through the official remote bridge (`openWorkspacePath`); it only opens paths already inside the workspace.

## Compatibility

| DeepSeek Harness | Status |
|---|---|
| `>=0.2.2-rc.1` | Supported (developed and tested on `0.2.2-rc.5`, desktop, Windows) |

Official packages the client injects: `dsh-client-locale`, `dsh-client-ui-primitives`, `dsh-client-ui-renderer`, `dsh-client-ui-conversation`, `dsh-client-ui-context-menu`, `dsh-client-ui-sidebar-right`, `dsh-client-ui-sidebar-files`, `dsh-api-remotes`. A DSH release that changes these surfaces may need a plugin update; the loader blocks activation when an injected package is missing.

## Development

```sh
npm test        # 80 automated tests (gestures, find bar, performance, leak guards)
```

The client is a single-file, no-build bundle (the module loader can only resolve table packages, not the plugin's own files), layered internally into pure helpers, domain factories (`createFindBar`, `createSelectionStore`, `createGestureLayer`, `createSendPipeline`) and one `apply` orchestration function.

## License

[MIT](./LICENSE)
