-- 安全策略三级作用域 + 来源锁定（2026-11-18 用户决策）。
--
-- 用户原话：
--   1) 要区分全局和针对某个资产或者某个类型资产的安全策略
--   2) owner 可以设置和开关自己资产的自定义的安全策略
--   3) 管理员可以设置全局的、某个资产或某个类型资产的策略；管理员设置的 owner 无法关闭和修改
--
-- 关键区分：既有的 `target` 列是**匹配维度**（tool/arg/asset_type/group），
-- 不是作用域。新增 `scope` 表示"这条规则对哪些资产生效"，两者正交
-- （例：作用于 k8s 品类的命令注入拦截 = scope=asset_type + target=arg）。

ALTER TABLE `guard_rules` ADD COLUMN `scope` text NOT NULL DEFAULT 'global';
--> statement-breakpoint
-- scope=asset_type → JSON 品类名数组；scope=asset → JSON 资产 id 数组；global → NULL
ALTER TABLE `guard_rules` ADD COLUMN `scope_value` text;
--> statement-breakpoint
-- 规则创建者（内置规则为 NULL）；owner 创建的规则只有本人与 admin 可改
ALTER TABLE `guard_rules` ADD COLUMN `owner_id` text;
--> statement-breakpoint
-- builtin | admin | owner：来源锁定依据（owner 不可改 admin/builtin 规则）
ALTER TABLE `guard_rules` ADD COLUMN `source` text NOT NULL DEFAULT 'builtin';
--> statement-breakpoint

-- 存量行回填：
-- 内置播种的规则（builtin=1）= builtin 来源、全局作用域，行为与升级前完全一致。
UPDATE `guard_rules` SET `source` = 'builtin', `scope` = 'global' WHERE `builtin` = 1;
--> statement-breakpoint
-- 非内置的历史行（此前只有管理员能创建）= admin 来源、全局作用域。
UPDATE `guard_rules` SET `source` = 'admin', `scope` = 'global' WHERE `builtin` = 0;
