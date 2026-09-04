import type { ReactNode } from "react";
import { BackButton } from "@/components/back-button";
import { cn } from "@/lib/utils";

interface MobilePageShellProps {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  backTo?: string;
  backButton?: ReactNode;
  actions?: ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  contentClassName?: string;
  titleClassName?: string;
  testId?: string;
}

export function MobilePageShell({
  title,
  subtitle,
  children,
  backTo,
  backButton,
  actions,
  className,
  headerClassName,
  bodyClassName,
  contentClassName,
  titleClassName,
  testId,
}: MobilePageShellProps) {
  return (
    <div className={cn("min-h-screen bg-background", className)} data-testid={testId}>
      <header
        className={cn(
          "sticky top-0 z-40 border-b border-border bg-background/95 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85",
          headerClassName,
        )}
      >
        <div className="max-w-lg mx-auto px-4 min-h-11 flex items-center gap-3">
          {backButton ?? <BackButton to={backTo} />}
          <div className="flex-1 min-w-0">
            <h1 className={cn("text-lg font-semibold tracking-tight truncate", titleClassName)} data-testid="text-page-title">
              {title}
            </h1>
            {subtitle ? <div className="text-sm text-muted-foreground mt-0.5 truncate">{subtitle}</div> : null}
          </div>
          {actions ? <div className="shrink-0 flex items-center gap-2">{actions}</div> : null}
        </div>
      </header>

      <main className={bodyClassName}>
        <div className={cn("max-w-lg mx-auto px-4 py-6 pb-20", contentClassName)}>
          {children}
        </div>
      </main>
    </div>
  );
}
