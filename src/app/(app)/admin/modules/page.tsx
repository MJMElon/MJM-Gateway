"use client";

import { RequireProfile, Spinner } from "@/components/guards";
import { ModulesManager } from "@/components/admin/modules-manager";
import { listApiKeys } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import type { Department, Module } from "@/lib/types";
import { useLoad } from "@/lib/use-load";

export default function ModulesPage() {
  const { data, reload } = useLoad(async () => {
    const supabase = createClient();
    const [modules, departments, keys] = await Promise.all([
      supabase.from("gw_modules").select("*").order("sort_order").order("name"),
      supabase.from("gw_departments").select("id, code, name").order("code"),
      listApiKeys(),
    ]);
    return {
      modules: (modules.data ?? []) as Module[],
      departments: (departments.data ?? []) as Department[],
      keys: Object.fromEntries((keys.keys ?? []).map((k) => [k.module_id, k.key_prefix])),
    };
  });
  return (
    <RequireProfile need="super">
      {() =>
        data ? (
          <ModulesManager {...data} functionsUrl={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1`} onChange={reload} />
        ) : (
          <Spinner />
        )
      }
    </RequireProfile>
  );
}
