import ChartStudio from '@/components/ChartStudio';

export default async function CreateChartPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ChartStudio songId={id} />;
}
