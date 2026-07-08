import GameScreen from '@/components/GameScreen';

export default async function PlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const runStage =
    sp.run === '1' ? Math.min(5, Math.max(1, Number(sp.stage) || 1)) : 0;
  // key forces a clean remount for each gauntlet stage
  return <GameScreen key={`${id}-${runStage}`} songId={id} runStage={runStage} />;
}
