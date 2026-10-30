# Diesel Claims 模块

车辆清单、现金加油报销（附收据照片）、油卡（Fleet Card）管理、报表。网址：`diesel/index.html`（Gateway 主画面上的「Diesel Claims」App）。

## 权限：两层

**第一层：Gateway 入口（User Setting → Module access）**

| 勾选 | 意思 |
|---|---|
| Access | 可以进入 Diesel 模块（但看得到哪些页面由第二层决定） |
| Admin | 这个模块的最高管理者（负责 DIESEL 的角色、Super Admin 也一样） |

**第二层：模块里的 User Access（只有模块管理者能设定，只列出第一层有 Access 的人）**

| 勾选 | 可以做 |
|---|---|
| Cash Claim | 报销自己用现金加的油（拍收据）；只看到自己的报销；待审核时可以修改、删除 |
| Report | 看报表（全部车辆、全部司机、现金＋油卡），导出 Excel |

只有 Access、没有勾任何页面的人：只看得到车辆清单。

## 页面

| 页面 | 谁看得到 | 内容 |
|---|---|---|
| Cash Claim | 勾了 Cash Claim 的人、管理者 | 本月用油、待审核、已批准未付款；新增报销（车辆、日期、里程、公升、金额、油站、收据照片） |
| Vehicles | 所有有 Access 的人 | 车辆清单；管理者新增 / 修改；有 Report 的人看到本月用油（现金＋油卡） |
| All claims | 管理者 | 全部现金报销：批准、拒绝（要写原因）、标记已付款、看收据、导出 Excel |
| Fleet Card | 管理者 | 油卡清单（卡号、发卡公司、绑定车辆、每月上限、余额）；记录充值；记录每次刷卡加油（哪张卡、哪台车、哪个司机、公升、金额、里程）；本月各司机刷卡 |
| Report | 勾了 Report 的人、管理者 | 每月：总公升、总金额、现金 vs 油卡；按车辆（现金、油卡、合计、行驶距离、km/L、超过油箱容量提醒）；按司机；导出 Excel |
| User Access | 管理者 | 勾选每个人的 Cash Claim / Report |

## 规则

- 审核人不能审核自己的报销（Super Admin 除外），自动记录审核人和时间；批准后报销人不能再修改
- 收据放在私有储存空间 `diesel-receipts`：只有本人、管理者和有 Report 的人打开得到（60 秒临时连结）
- 手机照片先压缩（最长 1600px）再上传，最大 10 MB；也可以上传 PDF
- 油卡余额 = 充值合计 − 刷卡加油合计；本月超过上限显示红色
- 刷卡加油选了跟油卡绑定不同的车辆，会先确认
- 新报销的里程比这台车上一次小，送出前会先确认

## 资料表

- `diesel_vehicles` 车辆；`diesel_claims` 现金报销
- `diesel_user_access` 模块里的页面权限（Cash Claim、Report）
- `diesel_cards` 油卡；`diesel_card_reloads` 充值；`diesel_card_usage` 刷卡加油

Migration：`supabase/migrations/20261101100000_diesel.sql`；测试：`supabase/tests/diesel.test.sql`（38 项）。

## 上线步骤

1. 套用 migration
2. Master Manage → Business：把「Diesel Claims」勾进车队所属的 Business
3. User & Group Manage → Module access：车队主管勾 Admin；司机、经理勾 Access
4. 车队主管进入 Diesel Claims：
   - Vehicles：新增车辆（可以指定常用司机）
   - Fleet Card：新增油卡、记录充值
   - User Access：司机勾 Cash Claim、经理勾 Report

## 之后可以加的

- 车辆、油卡记录 Excel 汇入（例如每月油卡公司的对帐单）
- 收据 OCR（自动读出公升和金额）
- 油耗趋势图、异常提醒（油耗突然变差、同一天加两次）
- 付款批次（一次把多笔已批准的报销标记为已付款，导出付款清单）
