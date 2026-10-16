import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { appAccessMode, publicBranding } from "@/lib/config";
import { isAdmin } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata: Metadata = { title: "Your hotel workspace", robots: { index: false, follow: false } };
export default async function DashboardPage() {
  const publicMode = appAccessMode() === "public";
  if (!await isAdmin()) redirect(publicMode ? "/login" : "/");
  return <Dashboard publicMode={publicMode} appName={publicBranding().name}/>;
}
