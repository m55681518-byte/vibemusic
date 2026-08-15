import { notFound } from "next/navigation";
import { loadMeta } from "@/lib/store";
import { PlayerView } from "@/components/PlayerView";

export const dynamic = "force-dynamic";

export default async function PlayerPage({ params }: { params: { id: string } }) {
  const meta = await loadMeta(params.id);
  if (!meta) notFound();
  return <PlayerView meta={meta} />;
}