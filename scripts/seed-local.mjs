// 本地开发用测试资料（只能对本机 Supabase 执行）
// 用法：node --env-file=.env.local scripts/seed-local.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url ?? "")) {
  console.error("拒绝执行：这个脚本只能用在本机 Supabase。");
  process.exit(1);
}
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PASSWORD = "Passw0rd123";

async function must(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

// 角色 HR：负责「全体员工」和「总部车队」，在「全体员工」负责 WIKI、HR 的权限，可以发公告
const [hrRole] = await must(
  db
    .from("gw_roles")
    .upsert(
      [
        {
          name: "HR",
          description: "人事",
          can_post_notice: true,
          can_delete_notice: true,
          can_grant_module: true,
          can_revoke_module: true,
          can_set_module_admin: true,
          can_add_business_user: true,
          can_remove_business_user: true,
          can_view_user_group: true,
          can_view_users: true,
        },
      ],
      { onConflict: "name" },
    )
    .select(),
);

const people = [
  { email: "super@mjm.local", full_name: "超级管理员", role: "super_admin", role_id: null, must_change_password: false },
  { email: "admin.hq@mjm.local", full_name: "总部管理员", role: "user", role_id: hrRole.id, must_change_password: false },
  { email: "driver@mjm.local", full_name: "陈司机", role: "user", role_id: null, must_change_password: false },
  { email: "ops@mjm.local", full_name: "林营运", role: "user", role_id: null, must_change_password: false },
  { email: "new@mjm.local", full_name: "新同事", role: "user", role_id: null, must_change_password: true },
  { email: "fleet.lead@mjm.local", full_name: "车队组长", role: "user", role_id: null, must_change_password: false },
];
const ids = {};
for (const p of people) {
  const { data: created, error } = await db.auth.admin.createUser({ email: p.email, password: PASSWORD, email_confirm: true });
  let id = created?.user?.id;
  if (error) id = (await must(db.rpc("gw_auth_user_id", { p_email: p.email })));
  ids[p.email] = id;
  await must(db.from("gw_profiles").upsert({ id, ...p }));
}

const modules = await must(
  db
    .from("gw_modules")
    .upsert(
      [
        { code: "DIESEL-HQ", name: "HQ 车辆 Diesel", icon: "fuel", url: "https://example.com/diesel", description: "总部车辆加油与耗油监控", category: "车队", access_level: 2, sort_order: 1 },
        { code: "MACHINERY", name: "机械工时", icon: "tractor", url: "https://example.com/machinery", description: "机械工作时数与维修记录", category: "机械", access_level: 1, sort_order: 2 },
        { code: "WIKI", name: "公司知识库", icon: "book-open", url: "https://example.com/wiki", description: "制度、表格与常见问题", category: "一般", access_level: 1, sort_order: 3 },
        { code: "HR", name: "人事请假", icon: "calendar", url: "https://example.com/hr", description: "请假与出勤", category: "一般", access_level: 1, sort_order: 4 },
        { code: "OPS-REPORT", name: "营运日报", icon: "chart", url: "https://example.com/ops", description: "每日营运数据", category: "营运", access_level: 1, sort_order: 5 },
      ],
      { onConflict: "code" },
    )
    .select(),
);
const mod = Object.fromEntries(modules.map((m) => [m.code, m.id]));

const groups = await must(
  db
    .from("gw_groups")
    .upsert(
      [
        { name: "全体员工", description: "公司所有员工", sort_order: 1 },
        { name: "总部车队", description: "总部司机与车队", sort_order: 2 },
        { name: "营运团队", sort_order: 3 },
      ],
      { onConflict: "name" },
    )
    .select(),
);
const grp = Object.fromEntries(groups.map((g) => [g.name, g.id]));

await must(
  db.from("gw_group_members").upsert(
    [
      ["全体员工", "admin.hq@mjm.local"],
      ["全体员工", "driver@mjm.local"],
      ["全体员工", "ops@mjm.local"],
      ["全体员工", "new@mjm.local"],
      ["总部车队", "driver@mjm.local"],
      ["总部车队", "new@mjm.local"],
      ["营运团队", "ops@mjm.local"],
      ["总部车队", "fleet.lead@mjm.local"],
    ].map(([g, e]) => ({ group_id: grp[g], user_id: ids[e] })),
  ),
);
// Company：独立主资料，可以属于多个 Business；对应到现有系统
const companies = await must(
  db
    .from("gw_companies")
    .upsert(
      [
        { code: "MJMP", name: "MJM Plantation Sdn Bhd", short_name: "MJM Plantation", sort_order: 1 },
        { code: "MJMA", name: "MJM Agro Sdn Bhd", short_name: "MJM Agro", sort_order: 2 },
      ],
      { onConflict: "code" },
    )
    .select(),
);
const co = Object.fromEntries(companies.map((c) => [c.code, c.id]));
await must(
  db.from("gw_business_companies").upsert(
    [
      ["全体员工", "MJMP"],
      ["全体员工", "MJMA"],
      ["总部车队", "MJMP"],
    ].map(([g, c]) => ({ group_id: grp[g], company_id: co[c] })),
  ),
);
// 每个 Business 有哪些 Icon（Business 标签）
await must(
  db.from("gw_group_modules").upsert(
    [
      ["全体员工", "WIKI"],
      ["全体员工", "HR"],
      ["总部车队", "DIESEL-HQ"],
      ["总部车队", "MACHINERY"],
      ["营运团队", "OPS-REPORT"],
    ].map(([g, m]) => ({ group_id: grp[g], module_id: mod[m] })),
  ),
);
// 逐个开给人；车队组长是 HQ 车辆 Diesel 的模块管理员
await must(
  db.from("gw_module_members").upsert(
    [
      ["admin.hq@mjm.local", "WIKI"],
      ["admin.hq@mjm.local", "HR"],
      ["driver@mjm.local", "WIKI"],
      ["driver@mjm.local", "HR"],
      ["driver@mjm.local", "DIESEL-HQ"],
      ["driver@mjm.local", "MACHINERY"],
      ["ops@mjm.local", "WIKI"],
      ["ops@mjm.local", "HR"],
      ["ops@mjm.local", "OPS-REPORT"],
      ["new@mjm.local", "WIKI"],
      ["new@mjm.local", "HR"],
      ["new@mjm.local", "DIESEL-HQ"],
      ["new@mjm.local", "MACHINERY"],
      ["fleet.lead@mjm.local", "DIESEL-HQ", true],
    ].map(([e, m, admin]) => ({ user_id: ids[e], module_id: mod[m], is_admin: !!admin })),
  ),
);
await must(
  db.from("gw_role_businesses").upsert(
    ["全体员工", "总部车队"].map((g) => ({ role_id: hrRole.id, group_id: grp[g] })),
  ),
);
await must(
  db.from("gw_role_modules").upsert(
    ["WIKI", "HR"].map((m) => ({ role_id: hrRole.id, group_id: grp["全体员工"], module_id: mod[m] })),
  ),
);
await must(db.from("gw_company_mappings").upsert({ company_id: co.MJMP, module_id: mod.MACHINERY, external_id: "12", external_name: "MJM PLANTATION" }, { onConflict: "module_id,external_id" }));
await must(db.from("gw_module_companies").upsert({ module_id: mod.MACHINERY, company_id: co.MJMP }));

// Diesel 模块（migration 已建立 DIESEL 模块）：放进「总部车队」；车队组长是 Admin，陈司机、新同事有 Access
// 模块里的 User Access：陈司机可以现金报销
const [diesel] = await must(db.from("gw_modules").select("id").eq("code", "DIESEL"));
if (diesel) {
  await must(db.from("gw_group_modules").upsert({ group_id: grp["总部车队"], module_id: diesel.id }));
  await must(
    db.from("gw_module_members").upsert(
      [
        ["fleet.lead@mjm.local", true],
        ["driver@mjm.local", false],
        ["new@mjm.local", false],
      ].map(([e, admin]) => ({ user_id: ids[e], module_id: diesel.id, is_admin: admin })),
    ),
  );
  await must(
    db.from("diesel_vehicles").upsert(
      [
        { plate_no: "WXY 1234", name: "Toyota Hilux", vehicle_type: "pickup", tank_capacity_l: 80, group_id: grp["总部车队"], driver_id: ids["driver@mjm.local"] },
        { plate_no: "BKT 5678", name: "Isuzu NPR", vehicle_type: "lorry", tank_capacity_l: 100, group_id: grp["总部车队"] },
        { plate_no: "EXC 01", name: "Excavator PC200", vehicle_type: "machinery", tank_capacity_l: 400, group_id: grp["总部车队"] },
      ],
      { onConflict: "plate_no" },
    ),
  );
  await must(db.from("diesel_user_access").upsert({ user_id: ids["driver@mjm.local"], can_claim: true }));
}
await must(db.from("gw_announcements").insert({ message: "欢迎使用 MJM Gateway！所有公司系统都可以从这里打开。", level: "info" }));

console.log(`完成。所有测试帐号的密码：${PASSWORD}`);
console.log(Object.keys(ids).join("\n"));
