import { useEffect, useRef, useState } from "react";

/**
 * Two-step confirm for one-click destructive actions (remove dataset, delete
 * session). First click arms the button, second click (or Enter on the armed
 * button) confirms; Escape, an outside click, or ARM_MS of inactivity disarms,
 * so a misclick can always be walked back.
 */

const ARM_MS = 4000;

interface ConfirmButtonProps {
  onConfirm: () => void;
  /** Accessible name of the resting button (e.g. "Remove dataset"). */
  ariaLabel: string;
  /** Resting content — usually the ✕ glyph. */
  children: React.ReactNode;
  confirmLabel: string;
  className?: string;
  confirmClassName?: string;
  title?: string;
}

export function ConfirmButton({
  onConfirm,
  ariaLabel,
  children,
  confirmLabel,
  className = "",
  confirmClassName = "text-[11px] font-medium text-danger hover:text-danger/70",
  title,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const armTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!armed) return;
    const disarm = () => setArmed(false);
    armTimer.current = window.setTimeout(disarm, ARM_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") disarm();
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) disarm();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      if (armTimer.current !== null) clearTimeout(armTimer.current);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [armed]);

  if (armed) {
    return (
      <span ref={rootRef} className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          className={confirmClassName}
          autoFocus
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="text-[11px] text-slate-500 hover:text-slate-300"
          onClick={() => setArmed(false)}
        >
          keep
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={className}
      title={title ?? confirmLabel}
      aria-label={ariaLabel}
      onClick={() => setArmed(true)}
    >
      {children}
    </button>
  );
}
