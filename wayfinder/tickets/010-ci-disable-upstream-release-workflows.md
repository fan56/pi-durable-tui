# 010 — CI 瘦身：禁用上游发布 workflow

日期：2026-10-13。状态：已执行。

## 背景

v0.7.1 tag push（首个让上游 `v*` 触发器生效的 tag）同时触发了上游继承的两个发布 workflow，全部失败：

- **Build Binaries**（`build-binaries.yml`，上游 Bun 二进制 + source archive 渠道）：`create-source-archive.sh` 校验 tag 与上游 `packages/coding-agent/package.json` 版本，`0.7.1 ≠ 1.1.0` 直接失败。该渠道本 fork 明确不用——durable store 依赖 `node:sqlite`，Bun 不实现（见 `scripts/build-durable-tui-release.sh` 头注）。
- **Nix**（`nix.yml`）：flake 构建成功，但 tag 冒烟要求 `pi --version` 等于 tag 号，输出 `1.1.0 ≠ 0.7.1` 失败。Nix 不是本 fork 的分发渠道（README 只承诺 Releases archive）。

v0.7.0 时这两个 workflow 未被 tag 触发（当时 YAML 触发器未注册，见 commit 511dbbe9c），所以问题直到 v0.7.1 才暴露。

## 决策

**在 GitHub 设置层禁用这两个 workflow（`gh workflow disable`），不改上游 YAML。**

- 理由：两者都是上游专用发布渠道，fork 的唯一发布渠道是 `durable-tui-release.yml`（v* tag → 4 平台自包含 archive → GitHub Release）；按 R4「优先不改上游」，设置层禁用零文件改动、随时 `gh workflow enable` 可逆。
- 禁用同时切断其 schedule / workflow_run / workflow_dispatch 触发（Nix 在 main 上的 10s 空转 run 与每日 schedule 一并静音，无价值损失）。

## 影响

- 今后 `v*` tag 只触发 Release workflow，不再有红叉噪音。
- 若未来要支持 Nix 安装，需先给 fork 自己的 VERSION 体系做 flake 适配 + 独立设计票，再重新启用。

## 关联

- AGENTS.md「Fork layer」末节已注明上游 Build Binaries / Nix 在本 fork 上禁用。
