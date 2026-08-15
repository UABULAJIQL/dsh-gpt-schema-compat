# @sqnb/dsh-gpt-schema-compat

[中文](README.md) | English

> **Status: Deprecated and unmaintained**
>
> This plugin was originally created only to address a DSH filesystem-sandbox issue observed with the standard GPT model on Windows. In practice, switching to the PTC model resolves the issue, so this plugin has no practical use.
>
> **Do not install or continue using this plugin. It is no longer maintained and will receive no bug fixes or feature updates.**

## Installation

This plugin has no practical use and is not recommended for installation. If you encounter the standard GPT model issue on Windows, switch to the PTC model instead of installing this plugin.

If the plugin is already installed, remove it.

## Historical behavior

The following only documents the plugin's historical purpose; the plugin is no longer maintained.

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
