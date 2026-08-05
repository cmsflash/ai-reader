import { ShareImport } from "@/components/ShareImport";

type SharePageProps = {
  searchParams: Promise<{
    error?: string;
    source?: string;
    text?: string;
    title?: string;
    url?: string;
  }>;
};

export default async function SharePage({ searchParams }: SharePageProps) {
  const params = await searchParams;

  return (
    <ShareImport
      error={params.error}
      source={params.source}
      text={params.text}
      title={params.title}
      url={params.url}
    />
  );
}
