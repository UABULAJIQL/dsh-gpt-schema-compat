# Changelog

All notable changes to this project are documented here.

## 0.3.3 - 2026-08-14

- Normalize GPT `pwsh` escalation arguments again: discard speculative requests before execution.
- Bind a retry to the actual GPT stream's top-level call id, command identity, and denied mode; nested calls and model-route overrides cannot create an entitlement.
- Preserve concurrent identical denials independently, expire unmatched eligibility only after a normal response, and keep it through stream errors or aborts.
- Request only the immediate wider sandbox mode after a matched denial, and never inject an escalation when approval policy is `never`; DSH still resolves approval and strict widening.

## 0.3.2 - 2026-08-14

- Stop rewriting `pwsh` calls so DSH's native same-turn sandbox escalation and approval flow remains available to GPT routes.

## 0.3.1 - 2026-08-11

- Add a GPT-only prompt rule that requires a current read before an edit and a re-read after observation or stale-content errors.

## 0.3.0 - 2026-08-11

- Restrict compatibility rewriting to `gpt-*` and `chatgpt-*` model routes.
- Preserve DSH approval prompts for one exact `write` or `edit` retry after a structured sandbox denial.
- Expire unmatched retry records after the next normal model response.
- Remove malformed GPT escalation fields from `pwsh` without auto-escalating arbitrary commands.

## 0.2.0 - 2026-08-11

- Initial stream-level compatibility bundle for DSH filesystem sandbox retries.
