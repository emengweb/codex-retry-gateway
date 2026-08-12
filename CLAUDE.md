<!-- workskill:begin section=claude-opt-loader -->
@.workskill/OPT.md

# WorkSkill 强制规则

1. 首先主动定位项目内部托管目录下的 `.workskill/OPT.md`。
2. 首次进入项目、`.workskill/OPT.md` 内容摘要变化、或没有可验证的当前 Task 恢复检查点时，必须在规划、回答或调用其他工具前完整读取 `.workskill/OPT.md`。同一 session 的 `resume`、`继续` 或 context compaction 恢复时，先核对检查点记录的 OPT 摘要；摘要未变则直接复用已加载规则并从检查点继续，不得仅因恢复重复全文读取。
3. 后续所有项目操作都必须遵循 `.workskill/OPT.md` 中适用的全部规则。
4. 当 `.workskill/OPT.md` 与平台策略、系统指令、开发者指令或用户当前明确指令冲突时，必须遵循后者。
5. 禁止编辑生成的 `.workskill/OPT.md`。
6. 项目专用补充规则只能写在本文件受管块之外或 `CUSTOM.md` 中。
<!-- workskill:end section=claude-opt-loader -->
