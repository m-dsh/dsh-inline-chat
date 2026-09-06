# dsh-inline-chat

DSH Web 全局辅助 Chat 插件：在页面右下角提供一个悬浮按钮和独立聊天面板。

## 行为

- 与当前工作区、当前页面和左侧会话记录完全独立。
- 不创建、不更新、不删除 DSH 会话记录。
- 使用 DSH 已配置的模型与账号；默认跟随 DSH 当前模型，也可在输入框底部切换模型和推理强度。
- 关闭面板不清空内容；刷新或重启 Web 后从浏览器本地恢复。
- “新建”只保留一个当前辅助 Chat，并清空旧内容后开始新的 Chat。
- 输入区沿用 DSH 风格：`Enter` 发送、`Shift + Enter` 换行，生成中发送按钮切换为停止按钮。
- 模型选择会保存在浏览器本地，下次打开继续使用。

## 本地开发

```bash
pnpm install
pnpm typecheck
pnpm build
```

安装到隔离 Web profile：

```bash
dsh plugin --profile web add link:/Users/username/Desktop/ai/dsh/dsh-inline-chat
```

然后重启 `dsh web`。此插件不依赖 `cloudflared`；若安装过程卡在 `cloudflared`，那是 DSH Web profile 的其他依赖安装步骤，不是插件运行代码主动启动的进程。
