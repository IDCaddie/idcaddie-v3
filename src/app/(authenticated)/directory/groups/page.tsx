import { DirectoryShell } from "../directory-shell";

export const metadata = { title: "Groups · ID Caddie" };

export default async function GroupsDirectoryPage() {
  return <DirectoryShell kind="groups" />;
}
