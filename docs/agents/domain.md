# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: single-context.** 本仓库只有一个上下文：一份根目录 `GLOSSARY.md` 记全部用语，架构决定放 `docs/adr/`。没有 `GLOSSARY-MAP.md`，也没有子项目级的 `GLOSSARY.md`——除非这个仓库以后真的拆成多个各自有独立用语的上下文，才改成 multi-context。

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root — 合同条款、抽取口径、售后条款这类业务用语的准确定义
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved — 本次初始化故意没有建 `GLOSSARY.md`，等第一次真正写下词条时再建。

## File structure

```
/
├── GLOSSARY.md            ← 还没建，第一次写下词条时创建
├── docs/
│   ├── adr/               ← 架构决定
│   └── agents/            ← 本目录：issue tracker / triage / domain 的消费规则
└── scripts/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
