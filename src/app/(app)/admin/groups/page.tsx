"use client";

import { RequireProfile, Spinner } from "@/components/guards";
import { GroupsManager } from "@/components/admin/groups-manager";
import { createClient } from "@/lib/supabase/client";
import type { Department, Group } from "@/lib/types";
import { useLoad } from "@/lib/use-load";

const count = (rows: { group_id: string }[] | null) =>
  (rows ?? []).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.group_id]: (acc[r.group_id] ?? 0) + 1 }), {});

export default function GroupsPage() {
  const { data, reload } = useLoad(async () => {
    const supabase = createClient();
    const [groups, departments, members, grants] = await Promise.all([
      supabase.from("gw_groups").select("*").order("sort_order").order("name"),
      supabase.from("gw_departments").select("id, code, name").order("code"),
      supabase.from("gw_group_members").select("group_id"),
      supabase.from("gw_group_modules").select("group_id"),
    ]);
    return {
      groups: (groups.data ?? []) as Group[],
      departments: (departments.data ?? []) as Department[],
      memberCount: count(members.data),
      moduleCount: count(grants.data),
    };
  });
  return (
    <RequireProfile need="super">{() => (data ? <GroupsManager {...data} onChange={reload} /> : <Spinner />)}</RequireProfile>
  );
}
