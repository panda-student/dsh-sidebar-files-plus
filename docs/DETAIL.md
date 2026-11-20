# dsh-sidebar-files-plus — 设计与实现说明

伴生插件：增强官方「工作区文件」树的手势能力，不改官方任何代码，全部走官方公开扩展点。

## 能力总览（按阶段交付，2026-11-20 全部实测）

| 阶段 | 能力 | 通道 |
| --- | --- | --- |
| ① | 单击选中 / Shift 范围 / Ctrl 加减选 / Ctrl+A 全选 | 树行 DOM 手势层 + pointerover 跟踪悬停 pane 的 keydown（可编辑焦点守卫） |
| ① | 底部浮动操作条：发送到对话、复制路径、偏好、清除 | 注入导航容器的浮层（browser storage 即时生效） |
| ① | 发送到对话 = `@路径` 引用插入输入框（不上传） | `conversation.input.dock` 会话槽组件自带 `inputActions` |
| ① | 右键菜单：发送 / 复制路径 / 办公文件用系统应用打开 | `ctx.contextMenus.register`（file/directory 目标族） |
| ① | 双击办公白名单文件 → 系统默认应用打开（失败回落预览+toast） | `ctx.remote.session.openWorkspacePath` |
| ① | 双击白名单外文件 → 官方右侧预览 | 双击不拦截，官方默认行为 |
| ① | 目录单击=选中且 aria-expanded 展开收起切换 | 官方树行为 + 手势层选中 |
| ② | 拖拽：树行 → 输入框 = 插入 @引用（多选整体拖出） | dragstart 写 `application/x-fsp-entries` 私有 MIME + text/plain 系统互通；drop 命中 composer 走发送桥 |
| ② | 外部文件拖到树上 = 拦截浏览器默认导航 + 引导 toast | DataTransfer `Files` 检测（官方 composer 落盘无第三方通道，见「平台边界」） |
| ② | 复制路径 → 系统剪贴板（text/plain 多行绝对路径） | `navigator.clipboard` |
| ③ | 剪贴板互通：粘贴任意位置 = 官方全局 paste 已把路径文本送入草稿 | 官方既有能力，插件不重复拦截（实测双插冲突） |

## 平台边界（2026-11-20 对运行装机的一手证据，勿再重探）

树内**移动/复制/删除/重命名/新建**在当前 DSH 平台对第三方插件无实现通道，插件不做假 UI：

1. 官方 `@deepseek-ai/dsh-api-workspace-files` 服务源码自述 "read-only … this service exposes no mutations"。
2. 客户端 `ctx.remote.session` 方法面（运行时枚举）只有会话管理 + openWorkspacePath，无 fs 写方法。
3. 新增 remote 命名空间被 inject 白名单门禁（"cannot get property without inject"），官方命名空间经 typert IDL 编译生成 zod 契约，第三方插件无编译器不可达。
4. `fileUploads.upload` 附件通道落内容寻址存储（"never a filesystem path"），不落工作区；`session.attachment` 仅收图片。
5. 官方设计意图：文件操作由会话 agent 的文件工具完成——树内选中 →「发送到对话」即此路径。

## 关键实现事实（装机前核实过的源码契约）

- 树行标记：`li[data-files-path=相对路径]`（内层 `div.row > button` 可点），目录/文件由 `data-files-entry` 区分；导航容器 `[data-files-navigator=paneId]`、`[data-files-root=绝对路径]`、行容器 `[data-files-body]`（官方 `dsh-client-ui-sidebar-files` 源码）。
- 发送桥：`conversation.input.dock` 是官方 conversation 工厂声明的会话作用域 list 槽，贡献组件自带 `sessionId` 与 `inputActions`（`uiSession.provide` 注入）；`insertText(text, captureInsertion())` CAS 插入；引用文本 `@路径`（含空格 `@"路径"`），模型侧 serialize 即原文（官方 reference 包 codec 透传）。
- 右键：`ctx.contextMenus.register({id,target:'file'|'directory',order,resolve})`，target 值 `{sessionId,path,paneId?}`；目录行的 paneId 不在 target 里，由手势层 contextmenu 捕获兜底。
- 双击打开：`ctx.remote.session.canOpenWorkspacePath()` → `openWorkspacePath({path})`（绝对路径，Host 桌面打开）。web profile 无桌面 Host → 回落 toast；桌面 profile 才有真开效果。
- 会话→cwd：`ctx.sessions.list` 快照 `byId[id].cwd`；同根多会话时优先 `retainedBy.mainView` 的当前会话。
- **observer 纪律（2026-11-19 冻结事故教训，改此文件内任何 DOM 写前必读）**：插件 MutationObserver 监听 `body subtree childList`，observer 回调路径上（syncBars/paint/refreshBars 及其下游）的**一切 DOM 写必须幂等**——textContent/hidden 先比对值再写（相同值赋值也会重建文本节点、再次触发 observer → 自激死循环），attribute 先 getAttribute 比对再 set/remove。新增 DOM 写必须走同一纪律，否则页面激活即冻结。syncBars 因此**无条件幂等重画**（官方树重渲染会换行节点抹掉选中属性，幂等重画自愈且无变化时零 mutation）。
- **验证纪律（2026-11-19）**：合成 DOM 事件不能模拟受信任点击的焦点行为，验收一律用 CDP `Input.dispatchMouseEvent/dispatchKeyEvent`；toast 在窗口顶部中央，验收截图必须整页截。
- **部署纪律（2026-11-20 symlink 事故，操作前必读）**：profile 的插件目录是指向工作区源目录的 pnpm symlink——部署路径上的任何 `Remove-Item` 都会**穿透 symlink 删除工作区源文件**（本文件曾被整删，靠 Edge 内存缓存 fetch + CDP 取回恢复）。部署一律走 `default-workspace/.fsp-deploy.ps1`（Copy-Item 覆盖 + hash 校验 + 重启），脚本内禁止删除操作。
- **取证手法（2026-11-20）**：源文件丢失时，Edge 内存缓存存有历史 combo 响应——`performance.getEntriesByType('resource')` 找 rev URL → 页内 `fetch(url,{cache:'force-cache'})` 落 window 变量 → CDP eval 取回（注意 helper 不 awaitPromise，Promise 会序列化成 `{}`，必须先落 window 再二次 eval 读字符串）。CDP `Debugger.getScriptSource` 对已 parse 的模块返回空（无 source cache），不可依赖。

## 设置项

- 手势偏好（操作条 ⚙ 弹层，浏览器存储即时生效）：办公双击开关、白名单扩展名（默认 `doc docx xls xlsx ppt pptx pdf wps et dps`）。

## 安全边界

- 插件不执行任何文件写操作（见「平台边界」）；全部数据流是文本引用与系统剪贴板文本。
- 「发送到对话」只插入文本引用，不上传内容；模型按自身文件工具读取。
