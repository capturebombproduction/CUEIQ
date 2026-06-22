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
  const resolver = React.useRef<((v: boolean) => void) | null>(null);

  const confirm = React.useCallback<ConfirmFn>((next) => {
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
            <DialogFooter>
              <Button variant="outline" onClick={() => settle(false)}>
                {opts.cancelText ?? "ยกเลิก"}
              </Button>
              <Button
                variant={opts.destructive === false ? "default" : "destructive"}
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
