import { StatusClient } from "@/components/StatusClient";

export default async function StatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StatusClient draftId={id} />;
}
