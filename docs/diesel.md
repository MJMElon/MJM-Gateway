# Diesel Claims 模块

车辆清单、加油报销（附收据照片）、审核、用油统计。网址：`diesel/index.html`（Gateway 主画面上的「Diesel Claims」App）。

## 谁能做什么（跟着 Gateway 的 DIESEL 模块权限）

| 身分 | 在 User Setting 怎么设定 | 可以做 |
|---|---|---|
| 司机 / 一般报销人 | 模块权限：DIESEL 勾 **Access** | 看车辆清单；替车辆报销加油（拍收据）；只看到自己的报销；待审核时可以修改、删除 |
| Diesel 管理员 | 模块权限：DIESEL 勾 **Admin**（或角色负责 DIESEL） | 以上全部 ＋ 新增 / 修改车辆；看全部报销；批准、拒绝（要写原因）、标记已付款；导出 Excel；看统计 |
| Super Admin | — | 全部 |

- 审核人不能审核自己的报销（Super Admin 除外），会自动记录审核人和时间
- 批准后报销人就不能再修改
- 收据放在私有储存空间 `diesel-receipts`，只有本人和 Diesel 管理员打开得到（60 秒的临时连结）
- 手机拍的照片会先压缩（最长 1600px）再上传，最大 10 MB；也可以上传 PDF

## 资料表

- `diesel_vehicles`：车牌（唯一）、名称、类型、燃料、油箱容量、所属 Business / Company、常用司机、状态
- `diesel_claims`：车辆、报销人、日期、里程、公升、金额（RM）、油站、收据路径、备注、状态（pending / approved / rejected / paid）、审核人、审核时间、审核备注

Migration：`supabase/migrations/20261101100000_diesel.sql`；测试：`supabase/tests/diesel.test.sql`。

## 统计怎么算

- 每台车每月：笔数、公升、金额、平均油价（不算已拒绝的）
- 行驶距离与油耗（km/L）：同一台车按里程排序，两次加油之间的公里数 ÷ 后一次加的油；需要报销时有填里程
- 提醒：单次加油量超过油箱容量；新报销的里程比上一次小时，送出前会先确认

## 上线步骤

1. 套用 migration（建立资料表、权限、收据储存空间，并在 Gateway 加上 DIESEL 模块）
2. Master Manage → Business：把「Diesel Claims」勾进车队所属的 Business
3. User & Group Manage → Module access：给车队主管勾 Admin、司机勾 Access
4. Diesel 管理员进入 Diesel Claims → 车辆，新增车辆（可以指定常用司机）

## 之后可以加的

- 车辆 Excel 汇入
- 收据 OCR（自动读出公升和金额）
- 每台车的油耗趋势图、异常提醒（例如油耗突然变差）
- 付款批次（一次把多笔已批准的报销标记为已付款，并导出付款清单）
- 加油卡（fleet card）对帐
