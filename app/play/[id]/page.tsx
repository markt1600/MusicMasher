import GameScreen from '@/components/GameScreen';

export default async function PlayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <GameScreen songId={id} />;
}
