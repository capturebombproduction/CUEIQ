import { AudioLines } from "lucide-react";
import { cn } from "@/lib/utils";

export function Brand({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const box =
    size === "lg" ? "h-10 w-10" : size === "sm" ? "h-6 w-6" : "h-8 w-8";
  const icon =
    size === "lg" ? "h-5 w-5" : size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const text =
    size === "lg" ? "text-2xl" : size === "sm" ? "text-base" : "text-lg";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-semibold tracking-tight",
        className
      )}
    >
      <span
        className={cn(
          "grid place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm",
          box
        )}
      >
        <AudioLines className={icon} />
      </span>
      <span className={text}>
        Cue<span className="text-primary">IQ</span>
      </span>
    </span>
  );
}
