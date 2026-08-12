<!-- workskill:begin section=opt-loader -->
# WorkSkill 强制规则

1. 首先主动定位项目内部托管目录下的 `.workskill/OPT.md`。
2. 首次进入项目、`.workskill/OPT.md` 内容摘要变化、或没有可验证的当前 Task 恢复检查点时，必须在规划、回答或调用其他工具前完整读取 `.workskill/OPT.md`。同一 session 的 `resume`、`继续` 或 context compaction 恢复时，先核对检查点记录的 OPT 摘要；摘要未变则直接复用已加载规则并从检查点继续，不得仅因恢复重复全文读取。
3. 后续所有项目操作都必须遵循 `.workskill/OPT.md` 中适用的全部规则。
4. 当 `.workskill/OPT.md` 与平台策略、系统指令、开发者指令或用户当前明确指令冲突时，必须遵循后者。
5. 禁止编辑生成的 `.workskill/OPT.md`。
6. 项目专用补充规则只能写在本文件受管块之外或 `CUSTOM.md` 中。
<!-- workskill:end section=opt-loader -->

<!-- ==================== WorkSkill ==================== -->

<!-- ==================== WorkSkill ==================== -->

# AGENTS.md

本仓库继承上级 `C:\Users\dashuai\Documents\Playground\AGENTS.md` 的全部规则，并补充以下项目约束：

- 全程中文沟通与代码注释，称呼用户为“牢大”。
- 工程事实优先读取 `README.md`、`build.md`、`err.md`、当前源码和本地测试。
- 行为改动必须先写失败测试，再做最小实现；完成前按 `build.md` 执行对应验证。
- 路由、拦截、内部重试和续写恢复属于高风险主链路，不做与请求无关的重构。
- 未经牢大明确允许，不重启或替换当前实际运行在 `127.0.0.1:4610` 的 gateway。
- 重复故障先查 `err.md`；新的根因、修复和防回归命令应回写 `err.md`。
- UI 由当前 Codex 实现和验证，不委派给 Gemini。
