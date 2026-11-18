-- 绑定级 SSH 用户名（2026-11-17 用户决策）：同一槽位的每条绑定可各自指定登录账号。
--
-- 背景：一个资产绑两条 ssh_key 凭证（如 root 私钥 + dev 私钥）时，账号是**绑定**的属性，
-- 不是资产的属性，也不一定与凭证固定绑定（同一份私钥可能在不同资产用不同账号）。
-- 解析优先级：绑定 username > 凭证 username 键 > 资产 host_conn.username。
--
-- 只在 SSH（native host）链路上生效；其他品类的槽位不读它。

ALTER TABLE `server_credentials` ADD COLUMN `username` text;
