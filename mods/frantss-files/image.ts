import { mkdir, unlink } from "fs/promises";
import { appHome, exec, window } from "herdr";

export async function copyImage(path: string): Promise<string> {
  // Herdr's image loader accepts only assets inside appHome, with a relative path.
  const folder = "frantss-files/previews",
    asset = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}${path.slice(path.lastIndexOf("."))}`,
    target = `${appHome()}/${asset}`;
  await mkdir(`${appHome()}/${folder}`, { recursive: true });
  try {
    const result =
      window()?.platform === "windows"
        ? await exec("powershell", [
            "-NoProfile",
            "-Command",
            "& { param($source, $target) Copy-Item -LiteralPath $source -Destination $target -ErrorAction Stop }",
            path,
            target,
          ])
        : await exec("cp", [path, target]);
    if (result.code !== 0) throw new Error(result.stderr || "Cannot copy image");
    return asset;
  } catch (error) {
    await removeImage(asset);
    throw error;
  }
}

export async function removeImage(asset: string | null): Promise<void> {
  if (asset) await unlink(`${appHome()}/${asset}`).catch(() => {});
}
