import { DirectoryShell } from "../directory-shell";

export const metadata = { title: "People · ID Caddie" };

export default async function PeopleDirectoryPage() {
  return <DirectoryShell kind="people" />;
}
