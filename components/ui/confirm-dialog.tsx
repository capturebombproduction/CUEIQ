"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
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

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={!!opts} onOpenChange={(o) => !o && settle(false)}>
        {opts && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{opts.title}</DialogTitle>
              {opts.description && (
                <DialogDescription className="whitespace-pre-line">
                  {opts.description}
                </DialogDescription>
              )}
            </DialogHeader>
            {needsTyping && (
              <div className="space-y-1.5">
                <p className="text-sm text-muted-foreground">
                  พิมพ์{" "}
                  <span className="font-semibold text-foreground">“{opts.requireTyped}”</span>{" "}
                  เพื่อยืนยัน
                </p>
                <input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canConfirm) settle(true);
                  }}
                  placeholder={opts.requireTyped}
                  className="w-full rounded-md border bg-muted/40 px-3 py-2 text-sm"
                />
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => settle(false)}>
                {opts.cancelText ?? "ยกเลิก"}
              </Button>
              <Button
                variant={opts.destructive === false ? "default" : "destructive"}
                disabled={!canConfirm}
                onClick={() => settle(true)}
              >
                {opts.confirmText ?? "ลบ"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}
