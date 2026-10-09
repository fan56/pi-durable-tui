# durable-p1 e2e

tmux 驱动真 TUI 的端到端验收套件：起真进程、走真模型（deepseek）、按场景按键注入 + 屏幕断言。这是 v0.1–v0.4 验收清单的可重复执行版，22 个场景。

## 跑法

```bash
e2e/durable-p1/run.sh            # 全量
e2e/durable-p1/run.sh --keep     # 失败时保留现场（lab 目录路径会打印）
e2e/durable-p1/run.sh boot tool  # 只跑指定场景
```

前置：

- 凭据：`~/.pi/agent/auth.json` 里有 deepseek（或环境变量 `DEEPSEEK_API_KEY`）
- tmux；macOS 自带 bash 3.2 可跑（脚本按其方言写）
- footer 场景需要本机存在 `~/repo/pi-powerline-footer`，缺失时 SKIP 不算失败

## podman 容器内跑（Linux 环境）

```bash
e2e/durable-p1/podman-e2e.sh              # 构建镜像 + 容器内全量
e2e/durable-p1/podman-e2e.sh boot tool    # 场景过滤透传
PODMAN_E2E_GLOBAL_SETTINGS=1 e2e/durable-p1/podman-e2e.sh   # 连全局 settings 一起挂载（默认关）
```

- 套件作为容器命令整体运行：tmux server 与套件同生命周期（分次 `podman exec` 不共享 tmux server，不可取）
- 挂载：`~/.pi/agent/auth.json`（只读，凭据）+ `~/repo/pi-powerline-footer`（只读，存在才挂）。durable 会话数据写容器内 `/root/.pi/agent/...`，随容器销毁
- 镜像内 apt 装 ripgrep/fd（Debian 的 fd 二进制叫 `fdfind`，已补 `fd` 符号链接）：否则 pi 首启在容器里自动下载二进制会超时，"Startup is still in progress" 永不完成，所有工具调用挂死——纯对话场景照常通过，极易误诊
- `--keep` 在容器模式下被忽略（现场随容器消失；取证用 `podman run --name X ... bash e2e/durable-p1/run.sh --keep <场景>` 再 `podman export` 挖现场，容器内 `/tmp` 有符号链接坑，`podman cp` 不可用）
- 本网络 docker.io 被 DNS 污染，基镜像需一次性引导：

```bash
podman pull docker.m.daocloud.io/library/node:24-bookworm-slim
podman tag  docker.m.daocloud.io/library/node:24-bookworm-slim docker.io/library/node:24-bookworm-slim
```

## 场景

| 场景 | 断言 |
|---|---|
| boot | 干净基础版启动、footer 显示 deepseek-flash、一问一答 |
| tool | bash 工具调用渲染 + 输出回传 |
| mcp | 内置 MCP 服务器连接（无 deferred 警告）、模型直调 `mcp__echo-test__add(17,26)`=43 |
| mcpcmd | `/mcp` 命令派发到扩展（面板显示 connected），且不泄漏给模型当 prompt |
| compact | 手动 `/compact` 摘要条目渲染（Compacted from N tokens）、二连触发 Already compacted |
| steer | 运行中插队：主命令 + 注入命令两条输出都出现 |
| mswitch | `/model` 切到 deepseek-v4-pro，下一轮用新模型出答案 |
| killu | 工具运行中硬杀进程，`-c` 续跑：interrupted 语义或结果补完 |
| cont | 续跑后历史重建（原 prompt 文本可见） |
| list | `--list` 列出本目录会话 |
| sessions | 暗号写入 → `/new` → `/sessions` 选择器（旧会话在列、当前会话被排除）→ 切回后暗号可见、新消息可答 |
| sessionflag | `--session <id>` 精确续跑 `--list` 查到的会话 |
| abort | 工具运行中 Esc 打断：durable interrupted 结果语义 |
| queue | agent 忙时排队的消息可见、随后被执行 |
| thinkcycle | 思考档位循环：off → low（BTab）→ high → max（再两下 BTab） |
| name | `/name` 改名后 `--list` 可见 |
| sessionsnew | `/sessions new`（扩展路径）建新会话并在其上完成工作 |
| locked | 单写者锁：B 持最新会话时，A 的选择器首行是 B 的会话、切过去被锁 |
| bashprefix | `!` 前缀直接跑 bash |
| toolerr | 工具失败（exit 7）错误回传渲染 |
| compactcont | `/compact` 后硬杀再 `-c`：压缩条目在转录重建中存活 |
| footer | powerline footer（☁️ 段 + 📁 边框）与 MCP 同载互不干扰 |
| extpick | 首启零扩展加载 → `/ext` 勾选 pi-powerline-footer → 保存后**重载即生效**（无需重启） |
| extboot | `/ext` 已保存的扩展组在裸启动时静默应用 |

`extpick`/`extboot` 依赖全局 settings.json 里存在 pi-powerline-footer 包（容器默认不挂载全局 settings，自动 SKIP）。

## 现场与清理

每次运行建独立 lab（mktemp），内含 `.pi/settings.json`（默认模型 + 验收用压缩阈值）与 `.pi/mcp.json`（内嵌 echo/add 测试服务器，exposure: direct）。durable 会话数据落在 `~/.pi/agent/experimental/durable-p1-sessions/<hash>/`，退出时连同 lab 一并删除（`--keep` 保留）。失败场景的屏幕快照存 `$LAB/<场景名>.pane`。

## 已知约束

- 真模型依赖网络与时延：断言均为轮询（60–150s 超时），个别场景偶发 flake 时重跑单场景即可（locked 对时序最敏感）
- `/model` 选择器的按键序列（菜单 Enter → Down → Enter）与 TUI 交互耦合较深，上游改菜单行为时此场景最先红
