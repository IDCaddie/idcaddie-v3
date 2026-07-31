import { DirectoryShell } from "../directory-shell";

export const metadata = { title: "Applications · ID Caddie" };

export default async function ApplicationsDirectoryPage() {
  return <DirectoryShell kind="applications" />;
}
