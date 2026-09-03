import { useEffect, useRef, useState } from "react";
import { getSessionRun, patchSessionRun } from "../sessionRuns";
import { loadDraft, saveDraft } from "../drafts";
import { inferDatasetType } from "../datasetType";
import type { TurnController } from "../hooks/useTurnRunner";
import { Composer } from "./Composer";

export type AttachKind = "inventory" | "access_log";

export function attachKind(name: string): AttachKind {
  return inferDatasetType(name) ?? (/\.(log|txt|json|jsonl|gz)$/i.test(name) ? "access_log" : "inventory");
}

/**
 * The Composer's state for one Task: the draft text (kept per task), the
 * attached file and its detected kind, and the element refs the runner and
 * the palette focus. Switching tasks restores that task's draft, or the text
 * of a Direction that failed while the user was looking at another task.
 */
export function useTaskComposer(sessionId: string | null) {
  const localId = useRef<string | null>(sessionId);
  localId.current = sessionId;
  const [text, setTextState] = useState("");
  const setText = (next: string) => {
    setTextState(next);
    saveDraft(localId.current, next);
  };
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const presetTypeRef = useRef<AttachKind | null>(null);
  const [attached, setAttached] = useState<File | null>(null);
  const [attachType, setAttachType] = useState<AttachKind | null>(null);

  useEffect(() => {
    const failed = sessionId ? getSessionRun(sessionId).failedText : null;
    if (failed) {
      setText(failed);
      patchSessionRun(sessionId!, { failedText: null });
    } else {
      setText(loadDraft(sessionId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const clearAttachment = () => {
    setAttached(null);
    setAttachType(null);
  };
  const onPickFile = (file: File | null) => {
    if (!file) return;
    const preset = presetTypeRef.current;
    presetTypeRef.current = null;
    setAttached(file);
    setAttachType(preset ?? attachKind(file.name));
  };
  const openFilePicker = () => {
    presetTypeRef.current = null;
    fileRef.current?.click();
  };

  return {
    text, setText,
    /** The live textarea value, for the runner's "only clear my own text" rule. */
    getText: () => taRef.current?.value ?? "",
    attached, attachType, clearAttachment, onPickFile, openFilePicker,
    taRef, fileRef,
    focus: () => taRef.current?.focus(),
  };
}

export type TaskComposerState = ReturnType<typeof useTaskComposer>;

/**
 * Delegate · Steer · Stop, wired to the one turn runner. An attachment rides
 * the dataset-upload path (a file cannot ride a steer, so with one attached a
 * steer becomes a new delegation once the current execution settles).
 */
export function useComposerActions({
  composer,
  runner,
  busy,
  uploading,
}: {
  composer: TaskComposerState;
  runner: TurnController;
  busy: boolean;
  uploading: boolean;
}) {
  const { text, attached, attachType } = composer;
  const send = () => {
    if (busy || uploading) return;
    if (attached) {
      const type = attachType ?? attachKind(attached.name);
      void runner.submitWithDataset(text.trim(), attached, type);
      return;
    }
    void runner.submit(text.trim());
  };
  const steer = () => {
    if (attached) {
      const type = attachType ?? attachKind(attached.name);
      void runner.steer(text.trim(), () => runner.submitWithDataset(text.trim(), attached, type));
      return;
    }
    if (text.trim()) void runner.steer(text.trim());
  };
  const stop = () => runner.stop();
  return { send, steer, stop };
}

export type ComposerActions = ReturnType<typeof useComposerActions>;

/** The one Agent input, mounted in the middle band of an empty task and
 * beneath the transcript otherwise. */
export function TaskComposerHost({
  composer,
  actions,
  busy,
  uploading,
  offline,
  onOpenSettings,
  settingsOpen,
  mentionables,
}: {
  composer: TaskComposerState;
  actions: ComposerActions;
  busy: boolean;
  uploading: boolean;
  offline: boolean;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  /** v1.13 — `@` completion source, forwarded to the Composer. */
  mentionables?: { id: string; filename: string }[];
}) {
  // Settings edits providers; when it closes, the model chip re-reads the list.
  const [modelRefreshKey, setModelRefreshKey] = useState(0);
  useEffect(() => { if (!settingsOpen) setModelRefreshKey((key) => key + 1); }, [settingsOpen]);
  return (
    <Composer
      text={composer.text}
      setText={composer.setText}
      attached={composer.attached}
      onClearAttachment={composer.clearAttachment}
      onPickFile={composer.onPickFile}
      onOpenFilePicker={composer.openFilePicker}
      fileRef={composer.fileRef}
      taRef={composer.taRef}
      busy={busy}
      offline={offline}
      uploading={uploading}
      onSend={actions.send}
      onStop={actions.stop}
      onSteer={actions.steer}
      onOpenSettings={onOpenSettings}
      modelRefreshKey={modelRefreshKey}
      mentionables={mentionables}
    />
  );
}
