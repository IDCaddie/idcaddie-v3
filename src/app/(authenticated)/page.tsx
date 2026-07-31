import { redirect } from "next/navigation";
import { DEMO_MODE } from "./nav-items";

export const metadata = { title: "ID Caddie" };

// The authenticated home is the read-only Dashboards summary. `/` redirects there so there is a single
// product landing instead of a debug/context skeleton. The signed-in user's OWN tenant/org context — with
// raw ids stripped — lives on /admin; no raw tenant/org UUIDs are rendered in normal UI. Access to
// everything the dashboard reads is enforced by Postgres RLS, not this page.
//
// DEMO MODE lands on /access instead. Dashboards leads with "App-user accounts visible: 0", which is
// TRUE for a directory-only tenant (that surface counts `app_users`, not discovered identities) but reads
// as an empty product. /access opens on the effective-access breakdown, which is the thing worth showing.
// Both routes remain reachable; only the default landing changes.
export default function ProtectedHome() {
  redirect(DEMO_MODE ? "/access" : "/dashboards");
}
