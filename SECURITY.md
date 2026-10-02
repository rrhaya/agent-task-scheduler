# Security / セキュリティ

This is a local automation tool running under your user account. It is **not** a hardened execution sandbox. This document records a focused manual review of the added scheduler and a targeted check of the retained upstream implementation, not an independent penetration test or a guarantee that vulnerabilities are absent.

このツールはユーザー権限で動くローカル自動化ツールです。安全な隔離環境そのものではありません。追加したスケジューラーを中心に手動レビューし、既存CLIの実行・権限設定も確認しました。第三者の監査や侵入テストを実施したわけではありません。

## Fixed findings / 修正した問題

| Finding | Exposure before fix | Fix |
|---|---|---|
| CLI option injection from task text | A local JSON/Markdown prompt beginning with a flag could be parsed as a Codex CLI option, including a sandbox-bypass flag | Insert `--` before the positional prompt; reject option-like/control-character session IDs |
| Reserved object-key identifiers | IDs such as `__proto__`, `constructor`, and `toString` collided with inherited object properties and could corrupt state bookkeeping | Reject reserved IDs for tasks and agents; use null-prototype reservation/config maps; validate stored task IDs and quota estimates |
| Ambient secrets inherited by workers | Every worker received the supervisor environment, potentially including GitHub tokens, cloud credentials and unintended API billing keys | Inherit selected OS/runtime settings only; require explicit `env` overrides for additional credentials |
| Log file overwrite and loose existing storage | Log append could follow a pre-existing symlink; creating a directory with mode 0700 did not tighten an already-permissive directory | Exclusive log creation, unique per-attempt filenames, ownership/mode checks for private directories, reject symlink state files/directories |
| Unbounded output retention | Logs could exhaust disk space; a malformed event stream without a newline could grow its parser buffer | 50 MB log cap and 1 MB worker-event line cap; terminate the worker on violation |

Japanese: タスク本文のCLIオプション注入、予約済みIDの衝突、秘密情報を含む環境変数の継承、ログの上書き・保存先権限、出力によるディスク／メモリ消費を修正しました。個別の回帰テストを追加しています。これらは新しい `agent-task-scheduler` の経路に対する対策です。

## Remaining trust boundaries / 残るリスク

- **Prompt injection / プロンプトインジェクション:** A label is an execution-selection mechanism, not an authentication boundary. Anyone able to edit a selected Issue can alter instructions. Review Issue bodies and label permissions. The task prompt's “do not publish” text is a behavioral instruction, not an enforcement control. Repository instructions and content are also agent inputs.
- **Provider tools and repository code / 実行権限:** Worktrees separate files, not processes, networks, credentials, or user privileges. Tests, Git hooks/filters, CLI hooks, plugins and configured tools can execute code. Claude Code inherits its own permission configuration; `allowedTools` grants auto-approval and is not an OS sandbox. The scheduler never requests a bypass flag, but cannot guarantee the vendor's existing configuration is restrictive. A VM/container with restricted networking and credentials is needed for hostile repositories/tasks.
- **Native credentials / 認証情報:** HOME remains available because official CLIs use their saved login. Environment filtering does not prevent an authorized tool from reading credential files accessible to that user. Custom executable paths, agent `env`, quota commands and configuration files must be trusted. The optional CCLimitPing helper has its own credential access and unofficial endpoint behavior.
- **Local state / ローカル状態:** Outputs and logs may contain confidential information. State is operator-owned configuration, not authenticated storage. A malicious process running as the same OS user can modify it; ownership and symlink checks are not a defense against a same-user attacker or all filesystem races. State files carry workspace/session identifiers; do not accept someone else's state directory.
- **Quota overspend / 利用枠:** Percentages and cost estimates can lag; active workers and other account users may consume more than expected. Admission is not a hard financial cap. Explicit API credentials or provider settings may select paid API usage. Verify the CLI's billing mode and vendor-side limits.
- **Legacy CLI / 既存CLI:** `scripts/codex-task-queue.mjs` is retained for compatibility. It supports broader permission options, automatic commits and integration under its own settings. New scheduler environment filtering, log limits and storage checks do not retrofit this legacy runner. Use the new entrypoint and treat legacy permission options separately.

## Validation / 検証

Regression tests exercise option separation, session-ID validation, reserved IDs, filtered worker credentials, private storage, log symlink rejection, and output caps. Existing tests cover exact-session continuation and no automatic replay after uncertain crashes. No malicious prompt was sent to a real model. Claude Code live execution remains unverified on this development machine.

回帰テストと既存の状態管理テストを実行しています。実モデルへの攻撃試行や、Claude Code実機での検証は行っていません。

## Reporting / 報告

Do not post tokens, private task bodies or sensitive logs in public Issues. If GitHub's private vulnerability reporting is enabled, use the repository's **Security → Report a vulnerability** flow. Otherwise contact the repository owner privately before posting sensitive details. This repository does not yet advertise a dedicated security email or a guaranteed response SLA.

トークンや非公開タスク、機密ログを公開Issueに貼らないでください。GitHubの非公開脆弱性報告が有効なら、その窓口を利用してください。未設定の場合は機密情報を公開する前に管理者へ非公開で連絡してください。専用メールアドレスや対応期限はまだ設定していません。
