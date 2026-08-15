import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

interface ShareSearchParams {
  url?: string;
  text?: string;
  title?: string;
}

function extractUrl(searchParams: ShareSearchParams): string | null {
  const raw = searchParams.url || searchParams.text || searchParams.title || "";
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/https?:\/\/[^\s]+/i);
  const candidate = urlMatch ? urlMatch[0] : trimmed;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export default function SharePage({ searchParams }: { searchParams: ShareSearchParams }) {
  const url = extractUrl(searchParams);
  if (!url) {
    redirect("/");
  }
  redirect(`/extract?url=${encodeURIComponent(url)}`);
}