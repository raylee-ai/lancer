# 每个会话独立 Git worktree

并行会话默认共用工作区目录，后写的文件会覆盖先写的。开启本功能后，每个会话得到当前仓库的一份独立检出和分支，Agent 的读、写和 bash 都在那份检出里执行。这和 Codex app、Cursor 2.0 把并行 Agent 放进各自 worktree 的做法相同：隔离的是工作文件，不是会话记录。

## 什么时候会创建

新建会话时可以选择「独立工作树」。本地控制接口和 `lancer-ctl new` 用 `worktree: true` / `--worktree` 表达同一件事。

- 工作区在 Git 仓库里，并且选项打开：创建分支 `lancer/<session-id>`，以及 `<git-common-dir>/lancer-worktrees/<session-id>` 这份 linked worktree。起点是当时的 `HEAD`。
- 文件夹不是 Git 仓库，或选项关闭：不创建 worktree，会话继续使用工作区目录。
- 已有的「本地 / 工作树」环境选择不变。那个「工作树」会把检出注册成另一个工作区。这里的选项是挂在同一个工作区的会话上。

会话文件仍记在原工作区，所以会话留在原来的列表里。只有 Agent 运行时的 cwd 指向 worktree。

## 界面

选中带 worktree 的会话时，会话名旁边显示分支，输入框上方显示分支和路径，并提供：

- **查看 diff**：相对创建时的提交，包含未提交和未跟踪文件。超过 1 MiB 会截断。
- **合回创建时所在分支**：先把 worktree 里未提交的改动提交到会话分支，再合并进创建 worktree 时工作区所在的分支。工作区检出必须干净。冲突会中止合并，工作区回到合并前。需要确认。
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
