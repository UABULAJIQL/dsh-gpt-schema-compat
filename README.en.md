# @sqnb/dsh-gpt-schema-compat

[中文](README.md) | English

DSH bundle for GPT filesystem sandbox retries that preserves normal DSH approval prompts.

## Install

```powershell
dsh plugin --profile web add https://codeload.github.com/UABULAJIQL/dsh-gpt-schema-compat/tar.gz/refs/heads/main
```

Stop and start `dsh web` after installation. A browser refresh does not load a new bundle.

## Behavior

- Only changes `gpt-*` and `chatgpt-*` model routes.
- Handles exact sandbox-denial retries for `write`, `edit`, or `pwsh` only.
- Removes speculative escalation fields from ordinary GPT `pwsh` calls; only a real denial from a top-level call emitted by the actual GPT stream permits the next wider mode, still through DSH approval.
- Does not inject escalation fields when approval policy is `never`; nested calls, other model streams, and different commands cannot obtain retry eligibility.
- Expires unmatched retry records after the next normal model response; model-stream errors and aborts do not consume eligibility.
- Adds a GPT-only read-before-edit reminder and requires a fresh read after edit observation or stale-content errors.
- Leaves DeepSeek, other model routes, and `bash` unchanged.

## License

MIT

Copyright (c) 2026 sqnb
