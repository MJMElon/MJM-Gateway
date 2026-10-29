"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Spinner } from "@/components/guards";

export default function AdminIndex() {
  const router = useRouter();
  useEffect(() => router.replace("/admin/users/"), [router]);
  return <Spinner />;
}
