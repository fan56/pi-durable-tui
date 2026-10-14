# 011 — CI 瘦身：禁用 Publish Model Catalog

日期：2026-10-14。状态：已执行。

## 背景

cherry-pick 上游 `195120a91`（opencode-go 端点迁移 + google-generative-ai 支持）后，模型目录内容首次实际变化，触发了上游继承的 **Publish Model Catalog**（`publish-model-catalog.yml`，`workflow_run` 跟在两条 CI 之后）：生成目录成功（42 providers / 1708 models），随后 `aws s3 cp` 到上游 R2 报 `Unable to locate credentials` 失败。

该 workflow 发布目标是**上游的** R2 桶（secrets `PI_ARTIFACTS_R2_*` 只存在于 `earendil-works/pi`），fork 仓永远不会有这对凭据——结构性必败，不是抖动。此前它一直是 skipped（目录无变化时发布步被跳过），所以从未暴露。

## 决策

**在 GitHub 设置层禁用（`gh workflow disable`），不改上游 YAML**——与 ticket 010 同一模式：

- 理由：fork 不消费上游的 R2 目录渠道；本仓模型目录的唯一校验点是两条 CI 里的 `check:model-data` 与生成器 `--strict` 门，均已保留。
- 设置层禁用同时切断 schedule / workflow_run / workflow_dispatch 触发，随时 `gh workflow enable` 可逆。

## 影响

- CI 双绿后不再出现 Publish Model Catalog 红叉噪音。
- 上游 R2 目录从此不含本 fork 的目录内容（本来也发不上去）。
