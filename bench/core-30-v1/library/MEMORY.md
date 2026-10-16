# MEMORY 索引

> 一行一条指针，正文在旁边的笔记文件里。归档区的条目只留作演变记录，不要当现状用。

## 用户偏好（user / feedback）

- feedback-error-reporting.md — 任务失败时的重试上限与汇报要求
- feedback-lint-before-commit.md — 提交前必须先过 lint
- feedback-no-push-to-main.md — 主分支不许直接推送
- feedback-no-version-bump.md — 版本号只由人工在发布流程里改
- user-code-comment-language.md — 注释与标识符的语言分工
- user-commit-language.md — 提交信息的语言与写法约定
- user-no-new-deps.md — 新增依赖前必须先征得同意
- user-pr-size.md — 拆分 PR 的行数阈值
- user-review-window.md — 本人参与代码评审的时间段
- user-test-data-policy.md — 测试数据只用虚构样本

## 项目（project）

- project-harborlight-build-target.md — Harborlight 正式构建的产物目录
- project-harborlight-node-version.md — Harborlight 构建机锁定的运行时版本
- project-harborlight-package-manager.md — Harborlight 统一使用的包管理器
- project-harborlight-test-runner.md — Harborlight 单测跑在哪个框架上
- project-kestrel-ci-runners.md — Kestrel 的 CI 跑在哪种机器上
- project-kestrel-config-path.md — Kestrel 配置文件的读取路径
- project-kestrel-env-var.md — Kestrel 指定根目录的环境变量（当前）
- project-kestrel-retry-count.md — Kestrel 同步失败后的重试次数（当前）
- project-kestrel-sync-schedule.md — Kestrel 自动同步的触发时间
- project-kestrel-token-budget.md — Kestrel 单次同步的数据量上限
- project-orchid-api-rate-limit.md — Orchid 公开接口的限流阈值
- project-orchid-branch-flow.md — Orchid 仓库当前采用的分支流
- project-orchid-cache-ttl.md — 生产环境图鉴缓存的过期时间
- project-orchid-db-port.md — Orchid 应用连接数据库走的端口（连接池）
- project-orchid-deploy-port.md — Orchid 生产环境的监听端口
- project-orchid-site-theme.md — Orchid 站点当前使用的主题
- project-team-standup.md — 组里站会的时间与形式
- project-tickly-availability-sla.md — Tickly 对外接口的可用性目标
- project-tickly-webhook-rotation.md — Tickly webhook 签名密钥的轮换周期

## 参考（reference）

- reference-harborlight-cache-clear.md — 构建结果与源码不一致时的处理办法
- reference-harborlight-preview-target.md — Harborlight 预览构建的输出目录
- reference-harborlight-theme-candidates.md — Harborlight 主题的候选与取舍理由
- reference-kestrel-conflict-resolution.md — 同步冲突时保留本地版本的做法
- reference-kestrel-manual-sync.md — 手动补同步的习惯时段
- reference-kestrel-offline-mode.md — 断网时同步的做法
- reference-orchid-fixture-reset.md — 测试夹具乱了之后的重置做法
- reference-orchid-log-location.md — 排查线上问题时先看哪个日志
- reference-orchid-migration-unlock.md — 迁移卡住时的恢复流程
- reference-orchid-staging-cache-ttl.md — 预发环境图鉴缓存的过期时间
- reference-orchid-staging-port.md — Orchid 预发环境的监听端口
- reference-release-checklist.md — 发版前的检查清单

## 归档（status: superseded）

- archive-harborlight-node-version-old.md — 已失效——Harborlight 早先的运行时版本
- archive-harborlight-package-manager-old.md — 已失效——Harborlight 早先的包管理器
- archive-harborlight-test-runner-old.md — 已失效——Harborlight 早先的单测框架
- archive-kestrel-ci-runners-old.md — 已失效——Kestrel 早先的 CI 机器
- archive-kestrel-env-var-old.md — 已失效——Kestrel 早先的根目录环境变量
- archive-kestrel-retry-count-old.md — 已失效——Kestrel 早先的重试次数
- archive-orchid-branch-flow-old.md — 已失效——Orchid 早先的分支流
- archive-orchid-db-port-old.md — 已失效——Orchid 早先直连数据库的端口
- archive-orchid-site-theme-old.md — 已失效——Orchid 站点早先的主题
