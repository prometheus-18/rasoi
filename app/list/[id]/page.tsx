import { ListClient } from "@/components/ListClient";

export default async function ListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListClient draftId={id} />;
}
