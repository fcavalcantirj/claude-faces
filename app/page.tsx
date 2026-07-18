// Minimal placeholder home route. The full conversation orchestrator UI
// (FaceSkin + FaceHud + SettingsPanel) replaces this in the
// "Wire the full conversation orchestrator" task.
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Agent Face</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Scaffold ready. The talking, lip-syncing particle face lands as the
        build progresses.
      </p>
    </main>
  );
}
