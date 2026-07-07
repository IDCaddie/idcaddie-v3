import { redirect } from "next/navigation";

export const metadata = { title: "ID Caddie" };

// The authenticated home is the read-only Dashboards summary. `/` redirects there so there is a single
// product landing instead of a debug/context skeleton. The signed-in user's OWN tenant/org context — with
// raw ids stripped — lives on /admin; no raw tenant/org UUIDs are rendered in normal UI. Access to
// everything the dashboard reads is enforced by Postgres RLS, not this page.
export default function ProtectedHome() {
  redirect("/dashboards");
}
