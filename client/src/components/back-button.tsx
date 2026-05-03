import { ArrowLeft } from "lucide-react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

type Tone = "default" | "onPrimary";

interface BackButtonProps {
  to?: string;
  onClick?: () => void;
  tone?: Tone;
  label?: string;
  className?: string;
  testId?: string;
}

export function BackButton({
  to,
  onClick,
  tone = "default",
  label = "Back",
  className,
  testId = "button-back",
}: BackButtonProps) {
  const [, setLocation] = useLocation();

  const handleClick = () => {
    if (onClick) return onClick();
    if (to) return setLocation(to);
    if (typeof window !== "undefined") window.history.back();
  };

  const base =
    "inline-flex items-center gap-1.5 h-11 pl-2.5 pr-4 rounded-full font-semibold text-base " +
    "shadow-sm border-2 transition-all active:scale-[0.97] " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

  const tones: Record<Tone, string> = {
    default:
      "bg-card text-foreground border-border hover:bg-accent hover:border-foreground/30 " +
      "focus-visible:ring-primary",
    onPrimary:
      "bg-white/15 text-primary-foreground border-white/40 backdrop-blur-sm " +
      "hover:bg-white/25 hover:border-white/60 focus-visible:ring-white",
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      data-testid={testId}
      className={cn(base, tones[tone], className)}
    >
      <ArrowLeft className="h-5 w-5 stroke-[2.5]" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
