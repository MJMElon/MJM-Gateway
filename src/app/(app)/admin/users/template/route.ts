import ExcelJS from "exceljs";
import { getTranslations } from "next-intl/server";
import { assertAdmin } from "@/lib/auth";

// 下载批量导入范本
export async function GET() {
  await assertAdmin();
  const t = await getTranslations("admin.users.import");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("users");
  sheet.columns = [
    { header: "email", width: 30 },
    { header: t("colName"), width: 16 },
    { header: t("colDepartment"), width: 14 },
    { header: t("colGroups"), width: 30 },
    { header: t("colRole"), width: 12 },
  ];
  sheet.addRow(["someone@example.com", "张三", "HQ", "全体员工, 总部车队", "user"]);
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="gateway-users-template.xlsx"',
    },
  });
}
