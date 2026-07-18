// Push-to-talk binding: hold Space (or press-and-hold the Talk button) to
// record, release to stop. Framework-free so it can back a React handler set or
// be attached to raw DOM, and headlessly testable.
//
// Guards that matter:
//  - key auto-repeat is ignored, so a held Space records exactly once;
//  - Space is ignored while focus is in a text field, so typing still inserts a
//    space instead of hijacking the mic;
//  - a start() failure is routed to onError (recoverable), never thrown;
//  - only a non-empty clip reaches onResult.

/** The minimal recorder surface push-to-talk drives. */
export interface RecorderLike {
  start(): Promise<void>;
  stop(): Promise<Blob>;
}

export interface PushToTalkOptions {
  recorder: RecorderLike;
  /** Fired with the captured clip on release (empty clips are dropped). */
  onResult?: (blob: Blob) => void;
  /** Fired if start()/stop() rejects (e.g. permission denied). */
  onError?: (err: unknown) => void;
  /** The keyboard key that triggers recording (default Space). */
  key?: string;
  /** Override the "is the user typing?" test (default INPUT/TEXTAREA/CE). */
  isTypingTarget?: (target: EventTarget | null) => boolean;
}

export interface PushToTalkController {
  onKeyDown(event: KeyboardEvent): void;
  onKeyUp(event: KeyboardEvent): void;
  onPointerDown(event?: { preventDefault?: () => void }): void;
  onPointerUp(event?: { preventDefault?: () => void }): void;
  /** Force-release (e.g. on window blur while holding). */
  cancel(): void;
  /** Attach to a DOM target; returns a detach function. */
  attach(target: {
    addEventListener: (t: string, h: EventListener) => void;
    removeEventListener: (t: string, h: EventListener) => void;
  }): () => void;
  readonly active: boolean;
}

function defaultIsTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
  };
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function createPushToTalk(options: PushToTalkOptions): PushToTalkController {
  const { recorder, onResult, onError } = options;
  const triggerKey = options.key ?? " ";
  const isTyping = options.isTypingTarget ?? defaultIsTypingTarget;

  let active = false;

  function press(): void {
    if (active) return;
    active = true;
    try {
      // Invoke start() synchronously so the recorder engages on the gesture;
      // route any (a)sync failure to onError without throwing at the callsite.
      Promise.resolve(recorder.start()).catch((err) => {
        active = false;
        onError?.(err);
      });
    } catch (err) {
      active = false;
      onError?.(err);
    }
  }

  function release(): void {
    if (!active) return;
    active = false;
    try {
      Promise.resolve(recorder.stop())
        .then((blob) => {
          if (blob && blob.size > 0) onResult?.(blob);
        })
        .catch((err) => onError?.(err));
    } catch (err) {
      onError?.(err);
    }
  }

  const controller: PushToTalkController = {
    get active() {
      return active;
    },
    onKeyDown(event: KeyboardEvent) {
      if (event.key !== triggerKey) return;
      if (event.repeat) return;
      if (isTyping(event.target)) return; // let the text field keep the space
      event.preventDefault?.();
      press();
    },
    onKeyUp(event: KeyboardEvent) {
      if (event.key !== triggerKey) return;
      event.preventDefault?.();
      release();
    },
    onPointerDown(event) {
      event?.preventDefault?.();
      press();
    },
    onPointerUp(event) {
      event?.preventDefault?.();
      release();
    },
    cancel() {
      release();
    },
    attach(target) {
      const onKeyDown = (e: Event) => controller.onKeyDown(e as KeyboardEvent);
      const onKeyUp = (e: Event) => controller.onKeyUp(e as KeyboardEvent);
      const onBlur = () => controller.cancel();
      target.addEventListener("keydown", onKeyDown as EventListener);
      target.addEventListener("keyup", onKeyUp as EventListener);
      target.addEventListener("blur", onBlur as EventListener);
      return () => {
        target.removeEventListener("keydown", onKeyDown as EventListener);
        target.removeEventListener("keyup", onKeyUp as EventListener);
        target.removeEventListener("blur", onBlur as EventListener);
      };
    },
  };

  return controller;
}
