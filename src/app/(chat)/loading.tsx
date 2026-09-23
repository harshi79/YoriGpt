import { YoriMark } from "@/components/ui/icon";

/**
 * Route-level loading state for the chat routes. It mirrors the shell's layout
 * (sidebar plus chat area) so the first paint does not jump when the
 * conversation list arrives.
 */
export default function ChatLoading() {
  return (
    <div className="app-shell" aria-busy="true">
      <div className="desktop-sidebar">
        <div className="sidebar" aria-hidden="true">
          <div className="sidebar-brand">
            <span className="brand">
              <YoriMark />
              <span>
                Yori<span className="brand-light">GPT</span>
              </span>
            </span>
          </div>
          <span className="skeleton skeleton-button" />
          <span className="skeleton skeleton-field" />
          <div className="skeleton-lines">
            <span className="skeleton" />
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
        </div>
      </div>
      <main className="main-panel" role="status">
        <span className="sr-only">Loading conversations…</span>
        <header className="chat-header">
          <span className="skeleton skeleton-field" />
        </header>
        <div className="chat-scroll-area">
          <div className="skeleton-lines skeleton-main" aria-hidden="true">
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
        </div>
        <div className="composer-region" aria-hidden="true">
          <span className="skeleton skeleton-field" />
        </div>
      </main>
    </div>
  );
}
