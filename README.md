# Contract-new

合同条款抽取与售后条款汇总工作区（福士汽车零部件（济南）有限公司）。

本仓库只放**脚手架与文档**：说明、规则、脚本、决策记录。
合同原件（254 个合同文件夹）、`导出清单.csv`、`福士汽车-售后服务条款提取汇总.xlsx`、`_work/` 下的流水线产物与 EmbedPDF 源码克隆都**不入库**——这些包含供应商商业信息，且体积达 GB 级。见 `.gitignore`。

## 目录

| 路径 | 说明 |
| --- | --- |
| `AGENTS.md` | 给 agent 的入口：issue tracker、triage 标签、域文档三行摘要 |
| `docs/agents/issue-tracker.md` | 追踪器约定：GitHub Issues + `gh` 命令 + wayfinder 地图/子票/阻塞操作 |
| `docs/agents/triage-labels.md` | 五个 triage 角色 → 本仓库实际标签串的映射 |
| `docs/agents/domain.md` | 域文档消费规则；布局为 single-context（根 `GLOSSARY.md` + `docs/adr/`） |
| `docs/agents/workspace.yaml` | 本工作区的 issue 追踪后端选择（matt skills deck 的锚文件，随仓库共享） |
| `scripts/` | 需要版本化的脚本（目前为空） |

`GLOSSARY.md` 与 `docs/adr/` 尚未创建：按 `docs/agents/domain.md` 的约定，等第一次真正写下词条或架构决定时再建。

## 本地工作区（不入库）

- `NNN_idNNN_<合同名>/` — 每个合同的原始文件与导出 markdown
- `导出清单.csv` — 合同台账：序号、任务 id、公司、发起时间、抽取状态
- `福士汽车-售后服务条款提取汇总.xlsx` — 售后条款提取结果
- `_work/` — 本地抽取流水线：`cand/` 候选 JSON、`norm/` 规范化全文、`out/` 分批抽取结果、`build.py` 汇总、`pdf-test/` 与 `embed-pdf-viewer/` 定位高亮验证

## Issue 追踪

本工作区使用 GitHub issues（仓库 `randyluo85/Contract-new`）记录地图、规格与实施票，
以 matt skills deck 工具（`deck_*`）读写。改后端前先跑一次 `deck_context` 确认真实状态。
