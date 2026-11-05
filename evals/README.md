# Coding agent evals

用一份固定的小任务集，测量一个 coding agent 能不能改对代码。仓库里只有任务编号和跑分程序，没有预置的 resolve rate。分数只会出现在你自己跑出来的 `evals/runs/` 里，那个目录不会进 git。

This harness measures whether a coding agent edits the right code. The repository stores instance ids and the runner. It does not store a resolve rate. Scores appear only in a directory you generate, `evals/runs/`, which is gitignored.

## 设计

Lancer 把模型调用放在正在运行的桌面应用里：界面发送，preload，IPC，conversation owner，Pi SDK driver，然后是 Pi。仓库对外的派活入口是本机控制接口，命令行是 [`scripts/lancer-ctl`](../scripts/lancer-ctl)。评测适配器调用 `new`、`wait`、`tail`、`logs`，走的是同一条路径。它不读 `~/.pi/agent/sessions`，也不另起一个 Pi。

另外两个适配器调用各自的官方 CLI，方便和 Lancer 对照：

| 适配器        | 入口                                          | 没安装时                                    |
| ------------- | --------------------------------------------- | ------------------------------------------- |
| `lancer`      | `scripts/lancer-ctl`                          | 跳过，原因 `not_running` 或 `not_installed` |
| `claude-code` | `claude --print --output-format json`         | 跳过，原因 `not_installed`                  |
| `codex`       | `codex exec --json --sandbox workspace-write` | 跳过，原因 `not_installed`                  |
| `mock`        | 进程内假代理                                  | 始终可跑，不访问网络，不需要密钥            |

密钥只从环境变量读取，不会写进仓库、命令行参数或报告：

- Claude Code：`ANTHROPIC_API_KEY`（官方端点）或 `ANTHROPIC_AUTH_TOKEN`（网关）。`--base-url` 写入子进程的 `ANTHROPIC_BASE_URL`。
- Codex：`OPENAI_API_KEY`。`--base-url` 同时设置子进程的 `OPENAI_BASE_URL`，并传 `-c openai_base_url=...`。Codex 现在更认配置项；环境变量仍作为旧版本的兼容。
- 可选评判模型：`OPENAI_API_KEY`，地址用 `OPENAI_BASE_URL` 或 `--judge-base-url`。
- Lancer 用的是已经打开的应用里配置好的供应商。`--base-url` 不会改应用设置。要走公司网关，先在 Lancer 里配好端点，再用 `--model provider/model-id`。

每个实例的流程：按 manifest 里的 `base_commit` 检出仓库，把 issue 正文交给适配器，用 `git diff` 收集补丁，再打分。官方打分调用 `python -m swebench.harness.run_evaluation`，在 Docker 里跑 FAIL_TO_PASS 和 PASS_TO_PASS。没有 Docker，或没有安装 `swebench` 时，退回到轻量检查：在干净检出上执行 `git apply --check`。这种结果的 `resolved` 是空的，resolve rate 显示为 `—`，不是 0%。报告里会写明退回原因。

失败归类是启发式，按这个顺序只取一个：

| 桶                        | 含义                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `timeout`                 | 代理超过给定的 wall time                                                                |
| `environment_setup_error` | 克隆失败，或官方 harness 没有写出报告                                                   |
| `empty_patch`             | 没有产生 diff                                                                           |
| `patch_does_not_apply`    | 干净检出上 `git apply --check` 失败                                                     |
| `tool_or_command_error`   | 日志里有命令失败、非零退出码或 Traceback，且还没有官方测试结论                          |
| `context_retrieval_miss`  | 补丁能应用，但改动的文件和官方 gold patch 的文件列表没有交集。gold patch 不会放进提示词 |
| `tests_fail`              | 测试跑了，实例没有 resolved                                                             |

`--judge` 会把启发式结果和一段日志发给 OpenAI 兼容的 chat completions，并在报告里标成 `llm_judge`。默认不覆盖启发式。加上 `--judge-override` 才会改桶。没有 `OPENAI_API_KEY` 时这个开关被忽略。

指标按适配器汇总：resolve rate（只统计 `resolved` 为 true 或 false 的实例）、patch-applies rate、代理 wall time 的平均数和中位数、token、费用、工具调用次数、轮次。适配器没报告的字段保持为空，不当成 0。费用优先用适配器报告的 `total_cost_usd`；只有同时给出 `--input-usd-per-million` 和 `--output-usd-per-million` 时，才用 token 估算，并标明 `token_price`。

## 任务子集

[`manifest/swebench_lite_subset.json`](manifest/swebench_lite_subset.json) 从公开数据集 `princeton-nlp/SWE-bench_Lite` 的 test split（300 条，12 个仓库）里选了 26 条。2026-11-05 通过 Hugging Face datasets server 读了每条的仓库、测试数量、gold patch 行数和 issue 长度，用来决定留哪些。正文、gold patch 和测试补丁都没有放进仓库。真正开跑时用 `datasets` 库现拉。

选择标准：每个仓库至少一条；避开 FAIL_TO_PASS 或 PASS_TO_PASS 特别大的实例（例如 `django__django-13321` 有 355 个失败测试，`pydata__xarray-4493` 有 1689 个回归测试）。难度标签只描述数据集形态：issue 很长、gold patch 很大、或测试列表很长，标成 `broader`；gold patch 不超过 20 行且测试列表短，标成 `localized`；其余是 `moderate`。这不是代理得分。

## 怎么跑

离线自测，不需要密钥、Docker 或数据集。CI 的 `pnpm test:baseline` 会调用它。

```sh
python3 evals/run.py --self-test
```

真实子集需要 Python 3.11+、git，以及：

```sh
python3 -m pip install -r evals/requirements.txt
```

先看本机有哪些适配器：

```sh
python3 evals/run.py adapters
```

用 mock 跑一条，确认能检出仓库并写出报告。mock 默认不改代码，所以不会得到 resolved。这只证明流水线，不证明模型能力。

```sh
python3 evals/run.py --adapter mock --limit 1
```

对照真实代理。没安装的会被跳过，退出码仍是 0。

```sh
python3 evals/run.py --all --timeout 900 --grade auto
```

只跑 Lancer。先打开 Lancer，在 Settings → General 打开 Allow local control API。

```sh
python3 evals/run.py --adapter lancer --model provider/model-id --timeout 1200
```

走公司网关：

```sh
export OPENAI_API_KEY="..."
python3 evals/run.py --adapter codex --base-url https://gateway.example/v1 --model gpt-5.4-mini
```

```sh
export ANTHROPIC_AUTH_TOKEN="..."
python3 evals/run.py --adapter claude-code --base-url https://gateway.example --model claude-sonnet-4-5
```

报告在 `evals/runs/<时间>/report.md` 和 `report.html`。`summary.json` 是同一份数字的机器可读版本。不要把这些文件提交上去。

常用开关：

| 开关                    | 作用                                           |
| ----------------------- | ---------------------------------------------- |
| `--instances a,b`       | 只跑 manifest 里的这些 id                      |
| `--grade official`      | 要求官方 Docker 打分；环境不够时仍退回轻量检查 |
| `--strict-grade`        | 官方打分没跑成时退出码 1                       |
| `--include-hints`       | 把数据集里的 hints 放进提示词。默认关闭        |
| `--judge`               | 额外的 LLM 归类，单独成列                      |
| `--run-local-tests`     | 只用于自定义题，在本机跑 `test_command`        |
| `--mock-spec file.json` | 让 mock 按用例改文件。单测用它，正式对比不要用 |

## macOS Apple Silicon（Mac mini M4）

1. 安装 Xcode Command Line Tools、Python 3.11 或更新版本、git。跑 Lancer 适配器还需要仓库要求的 Node（`>=22.19.0 <26`）。
2. 安装 Docker Desktop，给镜像留出磁盘。官方 SWE-bench 镜像主要是 `linux/amd64`。在 M4 上它们通过模拟运行，拉取的体积大，测试比 x86 慢。django、matplotlib、scikit-learn 是这 26 条里较重的环境。
3. 如果容器拉不下来或跑不起来，不要改报告。同样的命令会退回 `git apply --check`，`resolved` 留空。
4. Lancer 适配器：启动应用，确认 `~/Library/Application Support/Lancer/control.sock` 在应用运行时存在。开发配置改过 `PI_APP_USER_DATA_DIR` 时，给 `lancer-ctl` 相同的 `--user-data-dir`，或设置 `LANCER_USER_DATA_DIR`。
5. Claude Code 和 Codex 用各自的安装方式放到 `PATH`。不要把密钥写进 `~/.claude/settings.json` 的项目副本或仓库。

## Linux

1. Python 3.11+、git、以及能访问 Docker daemon 的用户。官方 harness 的目标平台是 Linux amd64，模拟不是必需的。
2. 同一条命令：`python3 evals/run.py --adapter mock --limit 1`，然后换真实适配器。
3. Lancer 的控制套接字在 `$XDG_CONFIG_HOME/Lancer`，未设置时是 `~/.config/Lancer`。控制接口目前没有 Windows 传输层；这个 harness 的说明覆盖 macOS 和 Linux。

## 换成自己的业务题

复制 [`examples/business-task-set.example.json`](examples/business-task-set.example.json)。每题需要 `instance_id`、`repo`、`repo_url`（https 或本机路径）、`base_commit`、`problem_statement`。`gold_files` 只用于失败归类。`test_command` 是可选的本机命令。

```sh
python3 evals/run.py --task-set evals/examples/business-task-set.example.json --adapter mock --run-local-tests
```

示例里的 `repo_url` 是占位符，直接跑会在克隆阶段记成 `environment_setup_error`。换成真实仓库后再看 `resolved`。`--run-local-tests` 在本机执行 `test_command`，`grade_mode` 是 `local_commands`。这不是 SWE-bench 的 Docker 分数。官方 harness 只接受它自己的数据集，所以业务题不要用 `--grade official` 来冒充 SWE-bench。

加一个新代理：在 `evals/lancer_eval/adapters/` 实现 `available()` 和 `run()`，让 `run()` 返回 `AgentResult`。`patch=None` 表示由 runner 收集 `git diff`。然后在 `build_adapters()` 里登记。密钥继续只放环境变量。

---

# English

## Design

Lancer dispatches model work inside the running desktop app: the UI, preload, IPC, the conversation owner, the Pi SDK driver, then Pi. The supported external entry point is the local control API, [`scripts/lancer-ctl`](../scripts/lancer-ctl). The Lancer adapter calls `new`, `wait`, `tail`, and `logs` on that path. It does not read `~/.pi/agent/sessions` and it does not start a second Pi.

Two more adapters call published CLIs so a run can compare them with Lancer:

| Adapter       | Entry point                                   | If it is missing                            |
| ------------- | --------------------------------------------- | ------------------------------------------- |
| `lancer`      | `scripts/lancer-ctl`                          | Skipped as `not_running` or `not_installed` |
| `claude-code` | `claude --print --output-format json`         | Skipped as `not_installed`                  |
| `codex`       | `codex exec --json --sandbox workspace-write` | Skipped as `not_installed`                  |
| `mock`        | In-process fake                               | Always ready. No network and no API key     |

API keys are read from the environment only. They are not written to the repo, to argv, or into the report.

- Claude Code: `ANTHROPIC_API_KEY` for the official host, or `ANTHROPIC_AUTH_TOKEN` for a gateway. `--base-url` sets `ANTHROPIC_BASE_URL` on the child process.
- Codex: `OPENAI_API_KEY`. `--base-url` sets `OPENAI_BASE_URL` and passes `-c openai_base_url=...`. Current Codex prefers the config key; the environment variable remains for older builds.
- Optional judge: `OPENAI_API_KEY`, with `OPENAI_BASE_URL` or `--judge-base-url`.
- Lancer uses the provider already configured in the open app. `--base-url` does not change app settings. Configure the company gateway in Lancer, then pass `--model provider/model-id`.

For each instance the runner checks out `base_commit`, gives the issue text to the adapter, collects `git diff`, and grades the patch. Official grading runs `python -m swebench.harness.run_evaluation` (FAIL_TO_PASS and PASS_TO_PASS in Docker). If Docker or the `swebench` package is missing, the runner falls back to `git apply --check` on a clean checkout. `resolved` stays null and the resolve rate renders as `—`, not as 0%. The report names the fallback reason.

Failure buckets are heuristics. The first match wins:

| Bucket                    | Meaning                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `timeout`                 | The agent exceeded the wall-time limit                                                                           |
| `environment_setup_error` | Clone failed, or the official harness wrote no report                                                            |
| `empty_patch`             | No unified diff                                                                                                  |
| `patch_does_not_apply`    | `git apply --check` failed on a clean checkout                                                                   |
| `tool_or_command_error`   | The log shows a failed command, a non-zero exit, or a traceback, and there is no official test result yet        |
| `context_retrieval_miss`  | The patch applies but its files do not overlap the gold patch file list. The gold patch is not put in the prompt |
| `tests_fail`              | Tests ran and the instance was not resolved                                                                      |

`--judge` sends the heuristic plus a log excerpt to an OpenAI-compatible chat completion. The report labels that column `llm_judge`. It does not replace the heuristic unless you also pass `--judge-override`. Without `OPENAI_API_KEY` the flag is ignored.

Per adapter, the report has resolve rate (instances whose `resolved` is true or false only), patch-applies rate, mean and median agent wall time, tokens, cost, tool calls, and turns. Unreported fields stay empty; they are not treated as zero. Cost prefers an adapter-reported `total_cost_usd`. A token estimate is used only when both `--input-usd-per-million` and `--output-usd-per-million` are set, and it is labeled `token_price`.

## Task subset

[`manifest/swebench_lite_subset.json`](manifest/swebench_lite_subset.json) holds 26 ids from the public `princeton-nlp/SWE-bench_Lite` test split (300 rows, 12 repos). On 2026-11-05 the Hugging Face datasets server was read for repo, test counts, gold-patch length, and issue length. Issue text, gold patches, and test patches are not in this repo. A real run downloads them with the `datasets` library.

Every repo appears at least once. Rows with very large test lists were left out (`django__django-13321` has 355 FAIL_TO_PASS tests; `pydata__xarray-4493` has 1689 PASS_TO_PASS tests). The difficulty label describes the dataset row: `broader` for a long issue, a large gold patch, or a long test list; `localized` for a gold patch of at most 20 lines and a short test list; otherwise `moderate`. It is not an agent score.

## Run it

Offline self-test. No API key, Docker, or dataset. `pnpm test:baseline` runs this.

```sh
python3 evals/run.py --self-test
```

A real subset needs Python 3.11+, git, and:

```sh
python3 -m pip install -r evals/requirements.txt
```

See which adapters this machine can run:

```sh
python3 evals/run.py adapters
```

Run one instance through the mock adapter to prove checkout and the report. The default mock does not edit code, so it will not resolve the instance. That checks the pipeline, not a model.

```sh
python3 evals/run.py --adapter mock --limit 1
```

Compare real agents. Missing ones are skipped and the exit code stays 0.

```sh
python3 evals/run.py --all --timeout 900 --grade auto
```

Lancer only. Start the app and enable Settings → General → Allow local control API.

```sh
python3 evals/run.py --adapter lancer --model provider/model-id --timeout 1200
```

Company gateway:

```sh
export OPENAI_API_KEY="..."
python3 evals/run.py --adapter codex --base-url https://gateway.example/v1 --model gpt-5.4-mini
```

```sh
export ANTHROPIC_AUTH_TOKEN="..."
python3 evals/run.py --adapter claude-code --base-url https://gateway.example --model claude-sonnet-4-5
```

Reports land in `evals/runs/<timestamp>/report.md` and `report.html`. `summary.json` is the same data. Do not commit that directory.

| Flag                    | Role                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `--instances a,b`       | Only these manifest ids                                                |
| `--grade official`      | Ask for the Docker harness; fall back when it cannot run               |
| `--strict-grade`        | Exit 1 if official grading did not run                                 |
| `--include-hints`       | Put dataset hints in the prompt. Off by default                        |
| `--judge`               | Extra LLM label, kept in its own column                                |
| `--run-local-tests`     | Custom tasks only. Run `test_command` on this machine                  |
| `--mock-spec file.json` | Make the mock edit files. Used by unit tests, not by a real comparison |

## macOS Apple Silicon (Mac mini M4)

1. Install Xcode Command Line Tools, Python 3.11 or newer, and git. The Lancer adapter also needs the repo's Node range (`>=22.19.0 <26`).
2. Install Docker Desktop and leave disk for images. Official SWE-bench images are mostly `linux/amd64`. On an M4 they run under emulation, so pulls are large and tests are slower than on x86. django, matplotlib, and scikit-learn are the heavier environments in this subset.
3. If a container cannot be pulled or started, leave the report as the fallback. The same command uses `git apply --check` and leaves `resolved` empty.
4. Lancer adapter: start the app and confirm `~/Library/Application Support/Lancer/control.sock` exists while it is running. If you set `PI_APP_USER_DATA_DIR`, pass the same directory to `lancer-ctl` with `--user-data-dir` or `LANCER_USER_DATA_DIR`.
5. Install the Claude Code and Codex CLIs onto `PATH`. Do not commit keys in a project `.claude` settings file.

## Linux

1. Python 3.11+, git, and a user who can talk to the Docker daemon. Linux amd64 is the platform the official harness expects.
2. Same command: `python3 evals/run.py --adapter mock --limit 1`, then a real adapter.
3. Lancer's socket lives under `$XDG_CONFIG_HOME/Lancer`, or `~/.config/Lancer`. The control API has no Windows transport; these instructions cover macOS and Linux.

## Custom business tasks

Copy [`examples/business-task-set.example.json`](examples/business-task-set.example.json). Each task needs `instance_id`, `repo`, `repo_url` (https or a local path), `base_commit`, and `problem_statement`. `gold_files` is used only for failure attribution. `test_command` is an optional host command.

```sh
python3 evals/run.py --task-set evals/examples/business-task-set.example.json --adapter mock --run-local-tests
```

The sample `repo_url` is a placeholder. Running it as-is records `environment_setup_error` at clone time. Point it at a real repository before reading `resolved`. `--run-local-tests` executes `test_command` on this machine and sets `grade_mode` to `local_commands`. That is not a SWE-bench Docker score. The official harness only grades its own dataset, so do not pass `--grade official` for a private task set and treat the result as SWE-bench.

To add an agent, implement `available()` and `run()` under `evals/lancer_eval/adapters/`. `run()` returns an `AgentResult`. `patch=None` tells the runner to collect `git diff`. Register it in `build_adapters()`. Keep keys in the environment.
