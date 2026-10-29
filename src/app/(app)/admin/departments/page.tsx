"use client";

import { RequireProfile, Spinner } from "@/components/guards";
import { DepartmentsManager } from "@/components/admin/departments-manager";
import { createClient } from "@/lib/supabase/client";
import type { Department } from "@/lib/types";
import { useLoad } from "@/lib/use-load";

export default function DepartmentsPage() {
  const { data, reload } = useLoad(async () => {
    const { data } = await createClient().from("gw_departments").select("id, code, name").order("code");
    return (data ?? []) as Department[];
  });
  return (
    <RequireProfile need="super">
      {() => (data ? <DepartmentsManager departments={data} onChange={reload} /> : <Spinner />)}
    </RequireProfile>
  );
}
