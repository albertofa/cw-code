import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Cloud, Languages, MicOff } from "lucide-react";
import type { AppSettings, GroqVoiceModel, GroqVoiceStatus, VoiceLanguage, VoiceProvider } from "../cw.js";
import { useConfirm } from "./ConfirmDialog.js";
import { MenuSelect, type MenuOption } from "./MenuSelect.js";
import { SettingsGroup, SettingsRow } from "./SettingsLayout.js";

const PROVIDER_OPTIONS: (MenuOption & { id: VoiceProvider })[] = [
  { id: "off", label: "Off", description: "The microphone button is hidden." },
  { id: "groq", label: "Groq (cloud)", description: "The audio is sent to Groq to be transcribed. Needs your own API key." }
];

const LANGUAGE_OPTIONS: (MenuOption & { id: VoiceLanguage })[] = [
  { id: "pt", label: "Portuguese" },
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "auto", label: "Detect automatically", description: "Slightly slower and less accurate than choosing the language." }
];

const GROQ_MODEL_OPTIONS: (MenuOption & { id: GroqVoiceModel })[] = [
  { id: "whisper-large-v3-turbo", label: "Whisper large v3 turbo", description: "Faster and cheaper. A good default." },
  { id: "whisper-large-v3", label: "Whisper large v3", description: "Most accurate, at a higher price." }
];

function isVoiceProvider(id: string): id is VoiceProvider {
  return PROVIDER_OPTIONS.some((option) => option.id === id);
}
function isVoiceLanguage(id: string): id is VoiceLanguage {
  return LANGUAGE_OPTIONS.some((option) => option.id === id);
}
function isGroqModel(id: string): id is GroqVoiceModel {
  return GROQ_MODEL_OPTIONS.some((option) => option.id === id);
}

function labelOf(options: MenuOption[], id: string): string {
  return options.find((option) => option.id === id)?.label ?? id;
}

const GROQ_NOTICE_TITLE = "Aviso de privacidade (LGPD): enviar áudio ao Groq";

/** Shown before Groq can be used, and again on request. The user accepts it for themselves. */
export const GROQ_NOTICE: ReactNode = (
  <div className="voice-notice">
    <p>
      Ao usar o ditado com o Groq, o áudio gravado pelo seu microfone é enviado pela internet à Groq (serviço de terceiros)
      para ser transcrito em texto.
    </p>
    <ul>
      <li>
        O áudio pode conter dados pessoais ou sensíveis, como dados de pacientes ou de clientes, ditos por você. Só dite esse
        tipo de informação se você tiver base legal e autorização para compartilhá-la com um operador externo, conforme a Lei
        Geral de Proteção de Dados (LGPD, Lei nº 13.709/2018).
      </li>
      <li>
        A chave de API é pessoal. O uso, o custo e a responsabilidade pelo que for enviado são seus. A Groq trata o áudio
        conforme os próprios termos e a política de privacidade dela; consulte-os antes de usar.
      </li>
      <li>O cw-code só envia áudio ao Groq enquanto esta opção estiver ativa, e não guarda a gravação depois da transcrição.</li>
      <li>
        Se você não quiser enviar áudio a terceiros, deixe o ditado desligado. Você pode retirar o aceite a qualquer momento
        nesta tela.
      </li>
    </ul>
  </div>
);

export function VoiceSettingsPanel({
  draft,
  onDraftChange
}: {
  draft: AppSettings;
  onDraftChange: (patch: Partial<AppSettings>) => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [status, setStatus] = useState<GroqVoiceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.cw.voice.groqStatus());
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Could not read the Groq status.");
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  /** Resolves true when the notice is accepted, recording the acceptance. */
  const acceptNotice = async (): Promise<boolean> => {
    const ok = await confirm({ title: GROQ_NOTICE_TITLE, message: GROQ_NOTICE, confirmLabel: "Entendi e aceito" });
    if (!ok) return false;
    setStatus(await window.cw.voice.acceptGroqNotice());
    return true;
  };

  const pickProvider = (id: string) => {
    if (!isVoiceProvider(id)) return;
    void run(async () => {
      if (id === "groq" && !status?.noticeAcceptedAt && !(await acceptNotice())) return;
      onDraftChange({ voiceProvider: id });
    });
  };

  const saveKey = () =>
    run(async () => {
      const result = await window.cw.voice.setGroqKey(keyInput);
      if (!result.ok) {
        setKeyError(result.message);
        return;
      }
      setKeyError(null);
      setKeyInput("");
      setStatus(result.status);
    });

  const provider = draft.voiceProvider;
  const noticeDate = status?.noticeAcceptedAt ? new Date(status.noticeAcceptedAt).toLocaleDateString() : null;

  return (
    <>
      <SettingsGroup title="Dictation">
        <SettingsRow label="Speech to text" hint="Adds a microphone button to the message box. The transcript lands in the box for you to review before sending.">
          <MenuSelect
            label="Speech to text provider"
            direction="down"
            value={provider}
            display={labelOf(PROVIDER_OPTIONS, provider)}
            icon={provider === "groq" ? <Cloud size={13} aria-hidden="true" /> : <MicOff size={13} aria-hidden="true" />}
            options={PROVIDER_OPTIONS}
            onPick={pickProvider}
          />
        </SettingsRow>
        {provider !== "off" && (
          <SettingsRow label="Language" hint="Telling Whisper the language is faster and more accurate than detecting it.">
            <MenuSelect
              label="Dictation language"
              direction="down"
              value={draft.voiceLanguage}
              display={labelOf(LANGUAGE_OPTIONS, draft.voiceLanguage)}
              icon={<Languages size={13} aria-hidden="true" />}
              options={LANGUAGE_OPTIONS}
              onPick={(id) => isVoiceLanguage(id) && onDraftChange({ voiceLanguage: id })}
            />
          </SettingsRow>
        )}
      </SettingsGroup>

      {provider === "groq" && (
        <SettingsGroup title="Groq">
          <SettingsRow label="Model">
            <MenuSelect
              label="Groq model"
              direction="down"
              value={draft.voiceGroqModel}
              display={labelOf(GROQ_MODEL_OPTIONS, draft.voiceGroqModel)}
              options={GROQ_MODEL_OPTIONS}
              onPick={(id) => isGroqModel(id) && onDraftChange({ voiceGroqModel: id })}
            />
          </SettingsRow>
          <SettingsRow
            label="Your API key"
            hint={
              status?.hasKey
                ? "A key is saved, encrypted by your operating system. It is only used from this app's background process."
                : "Create a personal key in the Groq console. Each person uses their own; it is never shared or stored in the app's settings."
            }
            htmlFor="voice-groq-key"
          >
            <div className="voice-key">
              <input
                id="voice-groq-key"
                className="field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={status?.hasKey ? "Paste a new key to replace it" : "gsk_…"}
                value={keyInput}
                disabled={busy || status?.encryptionAvailable === false}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && keyInput.trim()) void saveKey();
                }}
              />
              <button type="button" className="btn" disabled={busy || !keyInput.trim()} onClick={() => void saveKey()}>
                Save key
              </button>
              {status?.hasKey && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void run(async () => setStatus(await window.cw.voice.clearGroqKey()))}
                >
                  Remove
                </button>
              )}
            </div>
            {status?.encryptionAvailable === false && (
              <div className="settings-error" role="alert">
                This system cannot encrypt secrets, so cw-code will not store a key. Set up an OS keyring (GNOME
                Keyring or KWallet on Linux) and restart cw-code, or use cw-code on a machine that has one.
              </div>
            )}
            {keyError && (
              <div className="settings-error" role="alert">
                {keyError}
              </div>
            )}
          </SettingsRow>
          <SettingsRow
            label="Data-sharing notice"
            hint={noticeDate ? `You accepted it on ${noticeDate}. Audio is only sent while it stays accepted.` : "Groq stays blocked until you accept the notice."}
          >
            <div className="voice-key">
              <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => void (await acceptNotice()))}>
                {noticeDate ? "Review notice" : "Read and accept"}
              </button>
              {noticeDate && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void run(async () => setStatus(await window.cw.voice.revokeGroqNotice()))}
                >
                  Withdraw acceptance
                </button>
              )}
            </div>
          </SettingsRow>
        </SettingsGroup>
      )}

      {statusError && (
        <div className="settings-error" role="alert">
          {statusError}
        </div>
      )}
      {dialog}
    </>
  );
}
