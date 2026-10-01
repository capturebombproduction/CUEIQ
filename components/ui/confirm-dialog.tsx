"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { hasThai } from "@/lib/thai";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * App-wide in-app confirm dialog — the consistent replacement for native
 * window.confirm() on destructive actions (matches the DeleteEventButton style).
 * Mounted once via <ConfirmProvider> in the app layout; call sites use the hook:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: "ลบเพลงนี้?", description: "กู้คืนไม่ได้" }))) return;
 */
export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  /** Text of the action button (defaults to "ลบ"). */
  confirmText?: string;
  cancelText?: string;
  /** Red action button — true (default) for deletes. */
  destructive?: boolean;
  /**
   * Type-to-confirm guard for heavy, irreversible deletes (e.g. a whole band or
   * event that cascades its children). When set, the user must type this exact
   * text before the action button enables — stops a stray tap from wiping work.
   */
  requireTyped?: string;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = React.useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = React.useState("");
  const resolver = React.useRef<((v: boolean) => void) | null>(null);

  const confirm = React.useCallback<ConfirmFn>((next) => {
    // One resolver, one dialog. A second confirm() arriving while the first is
    // still awaiting an answer must NOT repaint the panel: the user is already
    // reading it with a finger over the red button, and swapping the text in
    // place (same DOM node, same footer slot) makes them approve something they
    // never read. Answer the newcomer "cancelled" — never leave it unresolved,
    // its caller is awaiting — and leave the dialog they can see alone.
    // Reachable because a confirm can be fired after an async run-up while the
    // page is still interactive (song-library's 🗑 waits on a setlist count).
    if (resolver.current) return Promise.resolve(false);
    setTyped(""); // fresh type-to-confirm field every time
    setOpts(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = React.useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpts(null);
  }, []);

  // When a type-to-confirm guard is set, the action stays locked until the typed
  // text matches exactly (trimmed) — a stray tap can't fire a cascading delete.
  const needsTyping = !!opts?.requireTyped;
  const canConfirm = !needsTyping || typed.trim() === opts!.requireTyped!.trim();
  const destructive = opts?.destructive !== false;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={!!opts} onOpenChange={(o) => !o && settle(false)}>
        {opts && (
          <DialogContent>
            {/* A delete reads as one at a glance: a red-tinted trash tile beside the
                title. The solid red button below is where a solid destructive fill
                belongs — the button that opened this sheet is the dashed
                destructive-outline (lib/destructive-fill.test.ts holds the line). */}
            <DialogHeader
              className={destructive ? "flex-row items-start gap-3 space-y-0" : undefined}
            >
              {destructive && (
                <span
                  aria-hidden
                  data-confirm-tile=""
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-[2px] bg-destructive/[.16] text-destructive"
                >
                  <Trash2 className="h-[21px] w-[21px]" />
                </span>
              )}
              <div className="min-w-0 space-y-1.5">
                <DialogTitle
                  className={
                    destructive && !hasThai(opts.title) ? "text-[30px] leading-[.95]" : undefined
                  }
                >
                  {opts.title}
                </DialogTitle>
                {opts.description && (
                  <DialogDescription className="whitespace-pre-line">
                    {opts.description}
                  </DialogDescription>
                )}
              </div>
            </DialogHeader>
            {needsTyping && (
              <div className="space-y-1.5">
                <p className="text-[13px] text-muted-foreground">
                  พิมพ์{" "}
                  <span className="font-semibold text-foreground">“{opts.requireTyped}”</span>{" "}
                  เพื่อยืนยัน
                </p>
                {/* 16 px at every width (the Input primitive drops to 14 from sm). The
                    match is exact, so nothing may rewrite what is typed: no iOS
                    auto-capital, no autofill, no spell-fix. */}
                <Input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canConfirm) settle(true);
                  }}
                  placeholder={opts.requireTyped}
                  aria-label={`พิมพ์ ${opts.requireTyped} เพื่อยืนยัน`}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-12 text-base sm:text-base"
                />
              </div>
            )}
            <DialogFooter>
              <Button variant="secondary" onClick={() => settle(false)}>
                {opts.cancelText ?? "ยกเลิก"}
              </Button>
              <Button
                variant={destructive ? "destructive" : "default"}
                disabled={!canConfirm}
                onClick={() => settle(true)}
              >
                {destructive && <Trash2 aria-hidden />}
                {opts.confirmText ?? "ลบ"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}
