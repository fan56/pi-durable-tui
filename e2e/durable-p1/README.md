# durable-p1 e2e

tmux 驱动真 TUI 的端到端验收套件：起真进程、走真模型（deepseek）、按场景按键注入 + 屏幕断言。这是 v0.1/v0.2 验收清单的可重复执行版。

## 跑法

```bash
e2e/durable-p1/run.sh            # 全量
e2e/durable-p1/run.sh --keep     # 失败时保留现场（lab 目录路径会打印）
```

前置：

- 凭据：`~/.pi/agent/auth.json` 里有 deepseek（或环境变量 `DEEPSEEK_API_KEY`）
- tmux；macOS 自带 bash 3.2 可跑（脚本按其方言写）
- footer 场景需要本机存在 `~/repo/pi-powerline-footer`，缺失时 SKIP 不算失败

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
| footer | powerline footer（☁️ 段 + 📁 边框）与 MCP 同载互不干扰 |

## 现场与清理

每次运行建独立 lab（mktemp），内含 `.pi/settings.json`（默认模型 + 验收用压缩阈值）与 `.pi/mcp.json`（内嵌 echo/add 测试服务器，exposure: direct）。durable 会话数据落在 `~/.pi/agent/experimental/durable-p1-sessions/<hash>/`，退出时连同 lab 一并删除（`--keep` 保留）。失败场景的屏幕快照存 `$LAB/<场景名>.pane`。

## 已知约束

- 真模型依赖网络与时延：断言均为轮询（60–150s 超时），个别场景偶发flake 时重跑单场景即可
- `/model` 选择器的按键序列（菜单 Enter → Down → Enter）与 TUI 交互耦合较深，上游改菜单行为时此场景最先红
