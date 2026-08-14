# @sqnb/dsh-gpt-schema-compat

中文 | [English](README.en.md)

为 GPT 的 DSH 文件沙箱重试提供兼容处理，同时保留 DSH 原有的审批弹窗。

## 安装

```powershell
dsh plugin --profile web add https://codeload.github.com/UABULAJIQL/dsh-gpt-schema-compat/tar.gz/refs/heads/main
```

安装后需要停止并重新启动 `dsh web`。仅刷新浏览器不会加载新的 bundle。

## 行为

- 仅影响 `gpt-*` 和 `chatgpt-*` 模型路由。
- 仅为完全匹配的 `write`、`edit` 或 `pwsh` 沙箱拒绝重试提供兼容处理。
- 常规 GPT `pwsh` 调用中的投机性权限升级字段会被移除；仅在实际 GPT 流生成的顶层调用真实遭遇沙箱拒绝后，才按权限阶梯保留下一档升级并由 DSH 审批。
- 审批策略为 `never` 时不会注入升级字段；嵌套调用、其他模型流或不同命令不能取得重试资格。
- 未匹配的重试记录会在下一次常规模型响应后过期；模型流错误或取消不会消耗资格。
- 为 GPT 添加编辑前读取文件的提醒；遇到编辑观察或陈旧内容错误后要求重新读取。
- 不影响 DeepSeek、其他模型路由或 `bash`。

## 许可证

MIT

Copyright (c) 2026 sqnb
