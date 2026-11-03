# 012 — CI 瘦身：禁用 Preview Packages

日期：2026-11-03。状态：已执行。

## 背景

上游 v1.5.0 同步（merge 939fd2085）随波引入 **Preview Packages**（`preview-packages.yml`，上游 #11260 "Set up preview packages"）。`workflow_run` 跟在每条 CI 之后：取 CI 产出的 preview 包工件，`PUT https://pkg.earendil.com/_/upload/<sha>/<package>?event=push` 上传到**上游的**预览注册表。

推 e43bfffac 后两条 CI 各触发一条：跟随 41582855253 的一条因 CI 未产包空转绿；跟随 41582855193 的一条真上传，`403 {"error": "Repository owner not allowed"}` 失败。

发布目标是 earendil 的预览注册表，fork owner（fan56）结构性不被放行——与 ticket 011 的 Publish Model Catalog（上游 R2 凭据）同族，不是抖动。

## 决策

**在 GitHub 设置层禁用（`gh workflow disable preview-packages.yml`），不改上游 YAML**——与 ticket 010/011 同一模式：

- fork 不消费上游的 preview 包渠道（fork 分发渠道只有 GitHub Release archive，见根 AGENTS.md「不发 npm」条目）。
- 设置层禁用同时切断 workflow_run / schedule / workflow_dispatch 触发，随时 `gh workflow enable` 可逆。

## 影响

- main 推送后不再出现 Preview Packages 红叉噪音（CI 双绿 + Environments 绿即为全绿）。
- 若上游未来把 preview 上传目标改为可配置端点，可重新评估启用。
