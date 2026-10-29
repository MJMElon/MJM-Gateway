import { getTranslations } from "next-intl/server";
import { LayoutGrid } from "lucide-react";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("app");
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-lg shadow-brand-600/30">
            <LayoutGrid className="size-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{t("name")}</h1>
            <p className="text-sm text-slate-500">{t("tagline")}</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
