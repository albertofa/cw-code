import { join } from "node:path";
import { exists, readReleaseUpdateInfo, sha512Base64 } from "./rehash.ts";
import { type SigningManifest, isInstallerPath } from "./signingManifest.ts";

export async function verifyReleaseSet(dir: string, manifest: SigningManifest): Promise<string[]> {
  const errors: string[] = [];
  try {
    const updateInfo = await readReleaseUpdateInfo(dir);
    if (updateInfo.version !== manifest.version) {
      errors.push(`signing.json version ${manifest.version} differs from update info version ${updateInfo.version}`);
    }
    const installer = manifest.files.find((file) => isInstallerPath(file.path));
    if (installer?.path !== updateInfo.installerName) {
      errors.push(`signing.json installer ${JSON.stringify(installer?.path)} differs from the update info installer ${updateInfo.installerName}`);
    } else if (installer.sha512 !== updateInfo.sha512) {
      errors.push(`signing.json installer sha512 differs from the update info sha512`);
    }
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  for (const file of manifest.files) {
    const path = join(dir, ...file.path.split("/"));
    if (!(await exists(path))) {
      errors.push(`${file.path} listed in signing.json is missing from ${dir}`);
      continue;
    }
    if ((await sha512Base64(path)) !== file.sha512) {
      errors.push(`${file.path} no longer matches the sha512 recorded in signing.json`);
    }
  }
  return errors;
}
