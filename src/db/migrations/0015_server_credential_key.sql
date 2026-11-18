-- 槽位绑定显式指定凭证键（ADR-031，2026-11-18 用户决策）。
--
-- 背景：绑定原先只记「槽位 X 用凭证 Y」，至于用 Y 里的**哪个键**靠按槽位名猜
-- （键名一致 → 归一化一致 → 凭证只有 1 个键 → 唯一敏感别名）。
-- 猜不到就炸：AUTH_PASS 归一化得 `pass`，ssh_key 凭证的键却是 `passphrase`，
-- 四级全不中，连通性测试直接报「缺少槽位键 "AUTH_PASS"」。
--
-- 本次改动（ADR-031 §2.2）：
--   1. NULL = 按槽位名匹配（键名完全一致 或 归一化后一致），匹配不到则 fail-closed；
--   2. 有值 = 精确取该键；
--   3. **删除**「单键兜底」与「敏感别名兜底」两级猜测。
--
-- 存量不自动回填（用户决策）：开发库 20 条绑定中 15 条靠同名/归一化继续可用，
-- 5 条（AUTH←password ×3、REDIS_PWD←REDIS_PASSWORD、AUTH_PASS←passphrase）
-- 在显式指定键名前会报错，由用户在界面上重选。

ALTER TABLE `server_credentials` ADD COLUMN `credential_key` text;
