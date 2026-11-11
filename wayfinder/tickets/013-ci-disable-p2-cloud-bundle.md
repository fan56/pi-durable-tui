# 013 — CI 瘦身：禁用 p2 Cloud Bundle

日期：2026-11-11。状态：已执行。

## 背景

上游 v0.12.0 同步随波引入 **p2 Cloud Bundle**（`p2-cloud-bundle.yml`）。两个结构性必败点叠加：

1. **双触发**：触发器 `workflow_run: workflows: [CI]` 按**名字**匹配，而仓内 `ci.yml` 与 `durable-tui-ci.yml` 都叫 "CI" → 每次 push 触发两条 p2 run。
2. **必败上传**：Upload 步（environment `pi-model-upload`）依赖 `secrets.PI_ARTIFACTS_R2_ACCESS_KEY_ID` / `PI_ARTIFACTS_R2_SECRET`，目标是上游私有 R2（`s3://pi-ui/`）；fork 无此凭据 → 必然 `NoCredentialsError` 红。

同步当天 13 跑 0 绿（8 failure + 5 skipped），是 "CI 一直挂" 观感的根因。

## 决策

**在 GitHub 设置层禁用（`gh workflow disable p2-cloud-bundle.yml`），不改上游 YAML**——与 ticket 010/011/012 同一模式：workflow 文件保留在仓内，fork 不消费上游的 p2 云端工件渠道；设置层禁用同时切断 workflow_run / workflow_dispatch 触发，随时 `gh workflow enable` 可逆。

## 影响

- main 推送后不再出现 p2 Cloud Bundle 红叉噪音（CI 双绿 + Environments 绿即为全绿）。
- 复现条件：若上游把 R2 凭据改造成可选/可配置端点，可重新评估启用。
