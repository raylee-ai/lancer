# 每个会话独立 Git worktree

并行会话默认共用工作区目录，后写的文件会覆盖先写的。开启本功能后，每个会话得到当前仓库的一份独立检出和分支，Agent 的读、写和 bash 都在那份检出里执行。这和 Codex app、Cursor 2.0 把并行 Agent 放进各自 worktree 的做法相同：隔离的是工作文件，不是会话记录。

## 什么时候会创建

新建会话时可以选择「独立工作树」。本地控制接口和 `lancer-ctl new` 用 `worktree: true` / `--worktree` 表达同一件事。

- 工作区在 Git 仓库里，并且选项打开：创建分支 `lancer/<session-id>`，以及 `<git-common-dir>/lancer-worktrees/<session-id>` 这份 linked worktree。起点是当时的 `HEAD`。
- 文件夹不是 Git 仓库，或选项关闭：不创建 worktree，会话继续使用工作区目录。
- 已有的「本地 / 工作树」环境选择不变。那个「工作树」会把检出注册成另一个工作区。这里的选项是挂在同一个工作区的会话上。

会话文件仍记在原工作区，所以会话留在原来的列表里。只有 Agent 运行时的 cwd 指向 worktree。

## 子会话隔离与改动回传

`create_child_thread` 支持 `isolation: "worktree" | "shared"`，默认 `"worktree"`。会改文件的任务使用默认值；只读调研可指定 `"shared"`。子会话以父会话**当前执行目录**为准：父会话有 worktree 时使用父 worktree，否则使用工作区目录。非 Git 目录下会退回共用该目录。

创建独立子 worktree 前，Lancer 用临时 Git 索引把父执行目录的已跟踪未提交改动和未被忽略的新文件做成快照提交，作为子分支起点和 `worktreeBaseSha`。这个过程不改父目录文件、真实索引、当前分支或 stash；Git 忽略的文件（例如 `node_modules`、`.env`）不会被复制。

子会话仍注册在原工作区，会话树和列表不变。独立子 worktree 使用 `lancer/<子会话 id>` 和仓库 common dir 下的 `lancer-worktrees/`，并保存 `worktreePath`、`worktreeBranch`、`worktreeBaseBranch`、`worktreeBaseSha`。`"shared"` 子会话直接使用父执行目录，不记录自己的 worktree。

每次符合分支回传条件的成功或失败结束事件，独立子 worktree 会先把当前改动（含未提交和未忽略的新文件）提交到子分支。回传证据同时保存分支名、快照起点 SHA、完成 SHA、改动文件列表和 diff 统计，并给父 Agent 提供后续指引。父 Agent 可用 `read_thread` 指定子线程和已记录的完成 SHA 读取该版本的完整 diff；显示内容最多 1 MiB。共享目录的回传会明确说明没有独立改动记录。

父 Agent 核对后可调用 `merge_child_thread`，并传入核对过的完成 SHA。界面上的「合回」确认也绑定当前显示的完成 SHA。合入前有两个前提：SHA 必须是最近一次交回的完成提交；子 worktree 当前状态（含未提交和未忽略的新文件）必须与该提交完全一致。旧版本会被拒绝，并提示先用 `read_thread` 阅读最新完成版本；存在完成后改动时，会拒绝合入，父 Agent 应用 `send_message_to_thread` 请子会话完成一轮并交回新版本，或由用户选择「丢弃并清理」放弃这些改动。检查使用临时索引，不修改子 worktree 的真实索引。子会话运行中不能合入，应等待其完成并交回。Lancer 把「快照起点 → 指定完成提交」的补丁应用到父会话当前执行目录，不要求父目录干净，也不修改父目录真实 Git 索引。冲突时补丁不会留下部分改动，工具返回冲突文件列表；父 Agent 应交由用户决定，不自动重试。成功后删除子 worktree 和 `lancer/` 分支、保留会话记录，并把该子会话后续执行目录改回父会话执行目录。未合入的子 worktree 可继续保留，或由用户丢弃清理。

每个工作区可在 Lancer 设置中配置一条「worktree 初始化命令」。命令只读取 Lancer 设置，不读取克隆仓库中的脚本；新建的手动或子会话 worktree 建好后在该目录执行。留空时不执行。失败不会阻止会话启动，退出码和末尾输出会写入子会话开工提示及父 Agent 回传。初始化命令执行时间不计入子会话初始提示的 10 秒启动确认；忽略文件不会自动复制，需由用户在初始化命令中自行准备。

## 界面

选中带 worktree 的会话时，会话名旁边显示分支，输入框上方显示分支和路径，并提供：

- **查看 diff**：相对创建时的提交，包含未提交和未跟踪文件。超过 1 MiB 会截断。
- **合回**：普通会话先提交 worktree 改动，再合并进创建 worktree 时工作区所在的分支；工作区检出必须干净。子会话则按回传记录的完成 SHA，把该版本补丁应用到父会话执行目录；允许父目录有未提交改动。两者都需要确认。
- **丢弃并清理**：删除 worktree 和 `lancer/…` 分支。会话记录保留，之后的回合回到工作区目录。需要确认，且会话不能正在运行。

合并和丢弃在会话运行中不可用。

## 命令行

```sh
./scripts/lancer-ctl new --cwd /path/to/repo --worktree --name '隔离实验' '在独立分支上改登录页'
./scripts/lancer-ctl new --draft --cwd /path/to/repo --worktree --name '待办'
```

Wire 请求在 `operation: "new"` 上增加布尔字段 `worktree`。省略或 `false` 与旧行为相同。成功回执多一个 `worktree`：未创建时为 `null`，创建后为 `{ path, branch, baseBranch }`。

`sessions` 在会话有 worktree 时带上 `worktreePath`、`worktreeBranch`、`worktreeBaseBranch`。`cwd` 仍是工作区目录；`executionCwd` 是 Agent 实际使用的目录。`set-result` 按 `executionCwd` 做路径约束，这样结果文件可以落在 worktree 里。

## 边界

- 只删除 `lancer/` 分支，且路径必须在该仓库的 `lancer-worktrees` 目录下。
- 同一仓库的创建、合并、删除按仓库串行，避免并行 `git worktree` 互相踩踏。
- worktree 目录在 `.git` 里，主检出的 `git status` 不会把它当成未跟踪文件。
- 合并产生的提交使用仓库已有的 Git 用户身份。未配置 `user.name` / `user.email` 时，合并会失败并保留 worktree。
