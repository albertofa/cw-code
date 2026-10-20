import { safeStorage } from "electron";
import type { SecretCipher } from "./groqCredentialStore.js";

/**
 * safeStorage backed by the OS keychain (DPAPI on Windows). On Linux without a keyring Electron falls back to a
 * hard-coded password ("basic_text"), which is not protection, so that case counts as unavailable.
 */
export function electronSecretCipher(): SecretCipher {
  return {
    isEncryptionAvailable: () => {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (process.platform !== "linux") return true;
      return safeStorage.getSelectedStorageBackend() !== "basic_text";
    },
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted)
  };
}
