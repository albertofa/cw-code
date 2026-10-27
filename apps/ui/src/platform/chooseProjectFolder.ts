export async function chooseProjectFolder(): Promise<string | null> {
  const local = window.cw.local;
  if (!local) throw new Error("choosing a folder on the server is not available yet");
  return local.pickProjectDir();
}
