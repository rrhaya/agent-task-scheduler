# Agent Task Scheduler

[English](README.md) | **日本語**

**GitHub Issuesや自分のタスクファイルを、Codex・Claude CodeなどのAIエージェントで並列に進めるライブラリとCLI**です。利用枠を確認し、普段の作業用の余力と実行中タスクの見積もりを残しながら、新しいタスクを投入します。

[Grey-G/codex-task-queue](https://github.com/Grey-G/codex-task-queue)のフォークです。元のMITライセンスとCLIを維持し、新しいスケジューラーを独立したモジュールとして追加しました。[元のREADME](docs/UPSTREAM_README.md)も保存しています。新しいスケジューラーは、既存CLIの自動コミット・マージ処理を呼び出しません。

## できること

- ラベル付きGitHub Issues、JSONファイル、Markdownフォルダからタスクを読み込む。
- 独立したタスクを、設定した最大並列数まで実行する。
- 5時間枠・週次枠など、取得できた利用枠すべてを確認する。
- 同じアカウントを使う複数のモデルでも、実行中タスクの見積もりを共有する。
- 制限に達したタスクを保存し、利用可能になったら同じエージェント・会話IDで再開する。
- タスクごとにGit worktreeを作り、差分と実行ログを残す。
- 入力先・エージェント・利用枠取得・状態保存をライブラリのインターフェースで差し替える。
- タスクがないときの定時warmupを、明示的な設定で有効にする。

成果物はレビュー待ちにします。自動でマージ、Issueのクローズ、PR作成、外部への投稿は行いません。

**残り枠を正確に使い切る保証はありません。** 使用率には反映遅延があり、消費量はタスクごとに変わります。設定した見積もりと余裕率で新規投入を制御します。学習による消費予測や、厳密な料金上限ではありません。実行中のタスクは残量低下だけでは停止せず、実際の制限エラーで待機に移ります。

## 導入

Node.js 18以上、Git、ログイン済みのエージェントCLIが必要です。GitHub Issuesを使う場合はGitHub CLIを用意し、`gh auth login`で認証してください。

```sh
git clone https://github.com/rrhaya/agent-task-scheduler.git
cd agent-task-scheduler
git checkout feat/quota-scheduler
npm install -g .
```

実行時のnpm依存パッケージはありません。グローバルインストールせず、`node bin/agent-task-scheduler.mjs`でも使えます。npmレジストリにはまだ公開していません。

## GitHub Issuesから始める

[設定例](examples/github-scheduler.json)をコピーし、次を設定します。

1. `repository`：対象の`owner/repo`。
2. `cwd`：コミット済みで未コミット変更がないローカルリポジトリの絶対パス。
3. `labels`：AIに任せるIssueのラベル。初期例は`agent-ready`。複数ラベルはAND条件です。
4. `stateDir`：対象リポジトリの外に置く、非公開の状態保存フォルダ。同じキューを管理するプロセスは同じ場所を使います。
5. `agents`：実際に導入・ログイン済みのエージェント。

```sh
# タスクを実行せず、利用枠と投入候補を確認
agent-task-scheduler plan --config /path/to/scheduler.json

# 今すぐ実行可能なタスクを進め、投入できなくなったら終了
agent-task-scheduler run --config /path/to/scheduler.json

# 新しいタスクと利用枠回復を継続監視
agent-task-scheduler watch --config /path/to/scheduler.json

agent-task-scheduler status --config /path/to/scheduler.json
```

Issueのタイトルと本文が実行指示になります。本文に任意のメタデータを追加できます。

````markdown
```task-json
{
  "priority": 10,
  "estimatedMinutes": 15,
  "estimatePercent": { "five_hour": 5, "weekly": 1 },
  "dependsOn": [12]
}
```
リトライ処理のバグを修正し、関連するテストを実行してください。
````

`alice/project`のIssue #42は、`alice.project.42`というタスクIDになります。依存するIssueにも同じ取り込みラベルが必要です。クローズ済みIssueは完了扱いです。コメントは取り込みません。ローカルの作業場所とエージェントは設定ファイルで決め、Issue本文からは変更できません。

ラベルを付けた本文はAIに実行させる指示として扱われます。ラベルを付ける権限と、本文を変更する権限を確認してください。

## 成果物の確認と完了

worktreeは`stateDir/worktrees`に残ります。差分、出力、ログを確認し、テストと元の作業リポジトリへの統合を済ませてから完了にします。

```sh
agent-task-scheduler approve --config /path/to/scheduler.json --task alice.project.42
```

この操作はローカル状態だけを変更します。マージやIssueのクローズは行いません。後続タスクのworktreeは元のリポジトリの現在の`HEAD`から作るため、**依存する変更を統合してからapproveしてください**。

実行を始めたタスクのタイトル・本文・メタデータを変更した場合、古い会話との食い違いを防ぐため処理を停止します。元に戻すか、新しいIssue・タスクIDを使ってください。

## 個人設定を環境変数で指定する

[個人設定用のJSON](examples/personal-scheduler.json)と[.env.example](.env.example)を使うと、リポジトリ名や作業フォルダを共有設定に書かずに済みます。

```sh
cp .env.example .env
# .envを編集し、リポジトリ・作業場所・状態保存先を設定
agent-task-scheduler plan --env-file .env
agent-task-scheduler watch --env-file .env
```

`.env`内の`AGENT_SCHEDULER_CONFIG`が設定ファイルを指します。`--config`を指定した場合はそちらを優先します。`.env`は自動では読み込まず、`--env-file`で指定したときだけ読みます。既存の環境変数は.envの値より優先します。

| 変数 | 内容 | 初期値 |
|---|---|---|
| `AGENT_SCHEDULER_CONFIG` | 設定ファイル | `--config`を省く場合は必須 |
| `AGENT_TASK_REPOSITORY` | GitHubの`owner/repo` | 必須 |
| `AGENT_TASK_WORKSPACE` | ローカルリポジトリ | 必須 |
| `AGENT_TASK_STATE_DIR` | 非公開の状態保存先 | 必須 |
| `AGENT_TASK_LABEL` | 取り込むIssueラベル | `agent-ready` |
| `AGENT_TASK_MAX_PARALLEL` | 最大並列数 | `3` |
| `AGENT_TASK_POLL_INTERVAL_MS` | 監視間隔（ミリ秒） | `60000` |
| `AGENT_TASK_RESERVE_PERCENT` | 短期枠の予約残量 | `20` |
| `AGENT_TASK_WEEKLY_RESERVE_PERCENT` | 週次枠の予約残量 | `30` |
| `AGENT_TASK_CODEX_COMMAND` | Codex実行ファイル | `codex` |

JSONの文字列値には`${NAME}`と`${NAME:-default}`を使えます。必須変数が未設定・空なら実行前にエラーにします。監視間隔や並列数などの数値も検証します。同じ方式でMarkdown・JSON入力の場所、Claudeの実行ファイル、モデル名、明示的なエージェント環境変数も設定できます。

.envは`KEY=value`、単純な引用符、コメント、任意の`export`接頭辞に対応します。値は文字どおりに扱い、シェル実行、`$HOME`、`~`、入れ子の変数展開、エスケープの解釈は行いません。個人設定には絶対パスを使ってください。JSON内の相対パスは設定ファイルの場所から、設定ファイル自体の相対パスは現在の作業フォルダから解決します。

`.env`、`.env.*`、`*.local.json`はGit対象外で、`.env.example`だけを共有します。例に本物の認証情報を書かないでください。.envを読み込んでも、そこにある秘密情報をワーカーへ自動では渡しません。GitHub CLIの認証にも自動では使用しないため、通常はCLIの保存済みログインを使ってください。

ライブラリでも`schedulerFromConfig(file, { envFile, env })`が使えます。`process.env`自体は書き換えません。

## Codexの設定

```json
"codex": {
  "type": "codex",
  "sandbox": "workspace-write",
  "timeoutMs": 3600000
}
```

保存済みの公式CLI認証を使用します。利用枠は公式app-serverの`account/rateLimits/read`で取得し、モデルを呼びません。実行は`codex exec --json`、再開は`codex exec resume <保存した会話ID>`です。モデルは`model`を指定しなければCLIの設定を使います。

sandboxは`read-only`または`workspace-write`です。権限回避フラグは設定しません。無人実行では`approval_policy=never`とし、追加承認が必要な操作は拒否されます。

## Claude Codeの設定

```json
"claude": {
  "type": "claude-code",
  "allowedTools": ["Read", "Glob", "Grep", "Edit", "Write"],
  "quota": { "type": "command", "argv": ["limitping", "status", "--json"] }
}
```

`claude -p --output-format stream-json --verbose`で実行し、`--resume`に保存した会話IDを渡します。認証と課金経路はCLIの設定に依存します。**利用中のClaudeバージョンで、非対話実行がどの利用枠・課金経路を使うか確認してください。** このツールはサブスクリプションだけを使うことを保証しません。

`--bare`や権限回避フラグは設定しません。`allowedTools`は自動承認するツールの設定であり、OSの隔離環境ではありません。例ではシェル実行を自動承認していません。

Claudeの利用枠取得は、この版には内蔵していません。[CCLimitPing](https://github.com/wavever/CCLimitPing)などの外部ヘルパーを利用できますが、そのエンドポイントは非公式です。取得方法を設定しない場合、残量不明としてClaudeへの投入を止めます。

## 別の利用枠取得方法

外部コマンドが次のJSONを出力する形にも対応します。時刻は**ミリ秒**です。

```json
{
  "known": true,
  "observedAt": 1790950000000,
  "windows": [
    { "id": "five_hour", "usedPercent": 40, "durationMins": 300, "resetsAt": 1790960000000 },
    { "id": "weekly", "usedPercent": 20, "durationMins": 10080, "resetsAt": 1791400000000 }
  ]
}
```

```json
"quota": { "type": "command", "argv": ["/path/to/read-quota", "--json"] }
```

監視プログラムが更新するファイルなら、`{"type":"file","path":"/path/to/live-quota.json"}`を指定します。観測から120秒以上経過した情報は、初期設定では採用しません。

枠が返されないことを「無制限」とは解釈しません。明示的に無制限として扱うカスタム取得方法には、`known: true, windows: []`と、ポリシーの`allowUnlimited: true`が必要です。

`quotaPool`の初期値はCodexが`codex`、Claudeが`claude`です。同一アカウントを使うモデル同士は同じ値にし、実行中タスクの見積もりを共有してください。アカウントの自動識別・切り替えは行いません。

## 余剰枠の使い方

```json
"policy": {
  "reservePercent": 20,
  "weeklyReservePercent": 30,
  "defaultEstimatePercent": 5,
  "weeklyEstimatePercent": 1,
  "safetyFactor": 1.5,
  "fitBeforeReset": true
},
"maxParallel": 3
```

初期例では短期枠の20%、週次枠の30%を残します。夜間用は予約残量を小さくした別設定にできますが、同じ`stateDir`を使用し、監視プロセスは1つだけ起動してください。不在時間の自動検知はありません。

`estimatedMinutes`があるタスクは、短期枠の更新までに終わる見込みがある場合だけ投入します。更新をまたいで進める場合は、その見積もりを省くか`fitBeforeReset`を無効にします。

投入前に「報告された残量 − 自分用の予約残量 − 実行中・直近終了タスクの見積もり」が、新しいタスクの見積もり以上か確認します。直近終了タスクの予約は初期設定で60秒残します。利用状況の反映遅延を考慮した余裕であり、厳密な消費上限ではありません。

## 制限後の再開・障害回復

`watch`はモデルを使わずに待ち、利用枠を再取得します。制限で停止したタスクは、必要な枠がすべて利用可能なら保存した会話で再開します。再試行間隔は最低30秒、`maxAttempts`は初期設定で合計10回です。

認証エラー、承認待ち、一般の障害、ユーザーによる停止、実行中の不確かなクラッシュは自動で再実行しません。状況を確認してから明示的に再試行できます。

```sh
agent-task-scheduler retry --config /path/to/scheduler.json --task alice.project.42
```

会話IDがある場合は維持します。`retry`は試行回数をリセットします。Ctrl-Cは実行中プロセスを停止し、中断状態を保存します。

監視プロセスのクラッシュ後はロックが残ります。記録されたPIDと子プロセスが停止していることを確認してから、`stateDir/scheduler.lock`を削除してください。異なる保存先で同じキューを二重実行しないでください。

## 定時warmup

```json
"warmup": { "at": ["04:00"], "timeZone": "Asia/Tokyo", "agents": ["codex"] }
```

`watch`が指定された分に起動しており、未処理・再開待ち・実行中タスクがなく、利用枠に余裕があり、5時間枠の`resetsAt`が`null`と報告されている場合に、小さな要求を1回送ります。不確かな状態では送りません。

スリープ解除、実行時刻を逃した場合の追いつき実行はありません。クラッシュ後の重複送信を避けるため、送信前に記録します。サーバー側の更新時刻を強制したり固定したりする保証はありません。

## ローカルファイルとライブラリ

[JSON設定例](examples/scheduler.json)、[タスク例](examples/tasks.json)、[Markdown例](examples/task-folder/review-tests.md)があります。現在のMarkdown形式は先頭の`task-json`メタデータと本文で1タスクです。普通のチェックリスト形式、Todoist、Linearはまだ対応していません。

入力ファイルは書き換えません。相対的な作業パスは入力ファイル・フォルダから解決します。全入力先でタスクIDを一意にしてください。

```js
import {
  Scheduler, FileStateStore, GitHubIssuesSource, CodexAdapter, QuotaPolicy
} from 'agent-task-scheduler';

const scheduler = new Scheduler({
  source: new GitHubIssuesSource({
    repository: 'alice/project', cwd: '/projects/project', labels: ['agent-ready']
  }),
  store: new FileStateStore('/private/agent-task-state'),
  agents: { codex: new CodexAdapter() },
  policy: new QuotaPolicy({ reservePercent: 20, weeklyReservePercent: 30 }),
  maxParallel: 3,
  onEvent: event => console.log(event)
});

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
await scheduler.run({ watch: true, signal: controller.signal });
```

拡張用のインターフェースは[TypeScript定義](lib/index.d.ts)にあります。

- `TaskSource.list()`：タスクを取得。
- `AgentAdapter.readQuota()`：利用枠を取得。
- `AgentAdapter.run()`：実行・会話の継続。
- `StateStore.read / write / lock`：状態の保存と排他制御。

カスタム入力は絶対パス・一意なID・依存関係・安定したfingerprintを返します。`validateTasks`を使って検証できます。カスタムエージェントは会話IDを早く通知し、完了と制限エラーを区別し、停止要求を処理する必要があります。CLIで設定できるエージェントは現在CodexとClaude Codeで、それ以外はライブラリから注入します。

## セキュリティ

詳しくは[SECURITY.md](SECURITY.md)を参照してください。CLIオプション注入、予約済みID、環境変数の継承、ログの上書き・肥大化に対する修正とテストを追加しています。

ワーカーはOS・実行環境用の一部の環境変数だけを引き継ぎます。GitHubトークン、クラウド認証情報、APIキー、`NODE_OPTIONS`は初期設定では渡しません。必要なものだけエージェントの`env`で指定してください。利用枠取得コマンドは管理者が指定する信頼済みプログラムとして扱い、監視側の環境を引き継ぎます。

Unixでは状態フォルダが自分の所有で権限`0700`、状態ファイルが`0600`である必要があります。ログは試行ごとに新規作成し、50MBで制限します。ワーカーのJSONイベント行は1MBを上限にします。状態やログに機密情報が含まれる可能性があるため、Git管理や共有フォルダに置かないでください。

**Git worktreeは変更を分離する仕組みで、安全な隔離環境ではありません。** Issue本文、リポジトリの指示、テスト、hooks、pluginsなどはAIや実行コードに影響します。信頼できないタスク・リポジトリは、権限と認証情報を絞ったVMやコンテナで実行してください。既存の`codex-task-queue`CLIには新しい保護を遡って適用していません。

## 検証状況と未対応

```sh
npm test
npm run pack:dry-run
```

模擬エージェントCLIと実際の一時Git worktreeでテストしています。Codex公式CLIによる利用枠取得も、モデルを呼ばずに確認しています。Claude Codeの実機実行は、開発環境にCLIがないため未確認です。

Web UI、npm公開、OS常駐サービスの自動設定、自動マージ、消費量の学習、厳密な料金上限、warmupの追いつき実行、自動的な別課金経路への切り替えは未対応です。
