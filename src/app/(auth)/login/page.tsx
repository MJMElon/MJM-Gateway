import { getTranslations } from "next-intl/server";
import { LoginForm } from "./login-form";

export async function generateMetadata() {
  const t = await getTranslations("login");
  return { title: t("title") };
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  return <LoginForm initialError={typeof error === "string" ? error : undefined} />;
}
