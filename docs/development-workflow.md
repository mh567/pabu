# Pabu 开发约定

- 仅在 `main` 分支开发，除非用户另行要求，不提交、不推送、不发布。
- 修改前检查 README、架构说明、当前工作记录及相关代码。
- 权限、同步和分享接口须通过实际 HTTP 流程验证。
- 完成后执行 `node --test tests/*.test.js`、相关 `node --check` 和 `git diff --check`。
- 变更功能边界时同步更新 README、架构说明和当前工作记录。
- 变更部署方式时同步更新 `pabu.sh`、`DEPLOYMENT.md` 和 README 部署章节，并对管理脚本执行 `bash -n` 检查。
