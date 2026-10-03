import { Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ProviderSettingsPanel } from "./agent/piweb/ProviderSettingsPanel.tsx";

export function HomepageProviderSettings({ locale, outputDir }: { locale: "zh-CN" | "en-US"; outputDir: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState("");
  const [error, setError] = useState("");
  const zh = locale === "zh-CN";
  const title = zh ? "供应商与模型设置" : "Provider and model settings";

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const config = await window.workshop.getAgentProviderConfig({ outputDir });
        const provider = config.providers[config.activeProviderId] as { name?: string; model?: string; enabled?: boolean; auth?: unknown } | undefined;
        if (!disposed) {
          setSelection(provider?.auth && provider.enabled !== false ? `${provider.name || config.activeProviderId} · ${provider.model || ""}` : "");
          setError("");
        }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
      }
    };
    void refresh();
    const unsubscribe = window.workshop.onAgentProviderUpdate(() => { void refresh(); });
    return () => { disposed = true; unsubscribe(); };
  }, [outputDir]);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  return (
    <section className="homepageProviderSettings">
      <div>
        <strong>{selection || (zh ? "先配置 Agent 使用的供应商与模型" : "Set up your Agent provider and model first")}</strong>
        <p>{zh ? "无需先打开 HTML；配置在所有项目和 HTML Agent 中共用。" : "No HTML needed. These settings are shared by all projects and HTML Agents."}</p>
        {error && <p role="alert">{error}</p>}
      </div>
      <button type="button" className="homepageProviderButton builtinTaskButton" onClick={() => setOpen(true)}><Settings2 size={18} />{title}</button>
      <dialog ref={dialog} className="homepageProviderDialog" aria-label={title} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
        {open && <div className="ynAgent"><ProviderSettingsPanel outputDir={outputDir} locale={locale} onClose={() => setOpen(false)} /></div>}
      </dialog>
    </section>
  );
}
