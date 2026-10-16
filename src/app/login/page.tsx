import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HotelLogin } from "@/components/hotel-login";
import { appAccessMode, publicBranding } from "@/lib/config";
import { isAdmin } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function generateMetadata(): Metadata {
  return { title: `Sign in · ${publicBranding().name}`, robots: { index: false, follow: false } };
}
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[]; notice?: string | string[] }> }) {
  if (appAccessMode() !== "public") redirect("/");
  const { next, notice } = await searchParams;
  const continueInstall = next === "/api/chatbeds/install";
  if (!continueInstall && await isAdmin()) redirect("/dashboard");
  return <HotelLogin name={publicBranding().name} continueInstall={continueInstall} notice={typeof notice === "string" ? notice : undefined}/>;
}
