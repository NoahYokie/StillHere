/**
 * TEMPORARY DIAGNOSTIC INSTRUMENT — Task 15.9E-D.1 (Runtime Telemetry Audit)
 *
 * READ-ONLY. This component measures and displays live WKWebView geometry on
 * screen so on-device telemetry can be captured by screenshot. It does NOT
 * modify layout, safe-area handling, MobilePageShell, capacitor.config, the
 * StatusBar, or any production behavior. The only DOM it owns is its own fixed
 * overlay (out of normal flow) and a hidden 0x0 probe used to read env() insets,
 * which cannot be read from JS any other way.
 *
 * Mounted only when import.meta.env.VITE_DIAGNOSTIC_TELEMETRY === "true".
 * REMOVE this file and its mount in main.tsx once the audit is complete.
 */
import { useEffect, useRef, useState } from "react";

type Box = {
  w: number;
  h: number;
  top: number;
  bottom: number;
  offsetH: number;
  clientH: number;
  scrollH: number;
} | null;

function box(el: Element | null): Box {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const h = el as HTMLElement;
  return {
    w: Math.round(r.width),
    h: Math.round(r.height),
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    offsetH: h.offsetHeight,
    clientH: h.clientHeight,
    scrollH: h.scrollHeight,
  };
}

export function DiagnosticTelemetryOverlay() {
  const probeRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("collecting…");
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    const collect = () => {
      const cs = probeRef.current ? getComputedStyle(probeRef.current) : null;
      const safeArea = {
        top: cs?.paddingTop ?? "n/a",
        bottom: cs?.paddingBottom ?? "n/a",
        left: cs?.paddingLeft ?? "n/a",
        right: cs?.paddingRight ?? "n/a",
      };
      const root = document.getElementById("root");
      const appRoot = (root?.firstElementChild as HTMLElement | null) ?? null;
      const vv = window.visualViewport;
      const topPx = parseFloat(safeArea.top) || 0;

      const data = {
        task: "15.9E-D.1",
        capturedAt: new Date().toISOString(),
        route: location.pathname + location.search,
        safeArea,
        geometry: {
          html: box(document.documentElement),
          body: box(document.body),
          root: box(root),
          appRoot: box(appRoot),
        },
        viewport: {
          innerH: window.innerHeight,
          innerW: window.innerWidth,
          visualViewportH: vv ? Math.round(vv.height) : null,
          visualViewportW: vv ? Math.round(vv.width) : null,
          visualViewportOffsetTop: vv ? Math.round(vv.offsetTop) : null,
          docClientH: document.documentElement.clientHeight,
          docScrollH: document.documentElement.scrollHeight,
        },
        ownership: {
          bodyHasCapacitorIos: document.body.classList.contains("capacitor-ios"),
          inferredWebviewOverlaysStatusBar: topPx > 0,
          innerVsVisualDelta: vv ? window.innerHeight - Math.round(vv.height) : null,
          bodyFillsInnerHeight:
            Math.abs((box(document.body)?.h ?? 0) - window.innerHeight) < 1,
          rootFillsInnerHeight: root
            ? Math.abs((box(root)?.h ?? 0) - window.innerHeight) < 1
            : null,
        },
      };
      setText(JSON.stringify(data, null, 2));
    };

    collect();
    const id = window.setInterval(collect, 1000);
    window.addEventListener("resize", collect);
    window.addEventListener("scroll", collect, true);
    window.visualViewport?.addEventListener("resize", collect);
    window.visualViewport?.addEventListener("scroll", collect);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", collect);
      window.removeEventListener("scroll", collect, true);
      window.visualViewport?.removeEventListener("resize", collect);
      window.visualViewport?.removeEventListener("scroll", collect);
    };
  }, []);

  return (
    <>
      {/* Hidden probe: the only way to read env(safe-area-inset-*) from JS. */}
      <div
        ref={probeRef}
        aria-hidden
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: 0,
          height: 0,
          visibility: "hidden",
          pointerEvents: "none",
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
        }}
      />
      <div
        style={{
          position: "fixed",
          left: 8,
          right: 8,
          bottom: 8,
          zIndex: 2147483647,
          maxHeight: collapsed ? 40 : "60vh",
          overflow: "auto",
          background: "rgba(0,0,0,0.88)",
          color: "#39FF14",
          font: "12px/1.4 ui-monospace, Menlo, Consolas, monospace",
          border: "1px solid #39FF14",
          borderRadius: 8,
          padding: 8,
          pointerEvents: "auto",
          WebkitUserSelect: "text",
          userSelect: "text",
        }}
      >
        <div
          onClick={() => setCollapsed((c) => !c)}
          style={{
            display: "flex",
            justifyContent: "space-between",
            color: "#fff",
            fontWeight: 700,
            marginBottom: collapsed ? 0 : 6,
            cursor: "pointer",
          }}
        >
          <span>DIAGNOSTIC · Task 15.9E-D.1 · WKWebView telemetry</span>
          <span>{collapsed ? "▸ tap to expand" : "▾ tap to collapse"}</span>
        </div>
        {!collapsed && (
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {text}
          </pre>
        )}
      </div>
    </>
  );
}
