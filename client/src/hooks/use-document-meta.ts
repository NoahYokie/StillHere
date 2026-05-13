import { useEffect } from "react";

type DocumentMeta = {
  title?: string;
  description?: string;
  noindex?: boolean;
};

function getMeta(name: string): HTMLMetaElement | null {
  return document.querySelector(`meta[name="${name}"]`);
}

function setMeta(name: string, content: string): void {
  let el = getMeta(name);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export function useDocumentMeta({ title, description, noindex }: DocumentMeta): void {
  useEffect(() => {
    const prevTitle = document.title;
    const prevDescription = getMeta("description")?.getAttribute("content") ?? null;
    const prevRobots = getMeta("robots")?.getAttribute("content") ?? null;

    if (title) document.title = title;
    if (description) setMeta("description", description);
    if (noindex) setMeta("robots", "noindex, nofollow, noarchive, nosnippet");

    return () => {
      document.title = prevTitle;
      if (description !== undefined) {
        if (prevDescription !== null) setMeta("description", prevDescription);
      }
      if (noindex) {
        setMeta("robots", prevRobots ?? "index, follow");
      }
    };
  }, [title, description, noindex]);
}
