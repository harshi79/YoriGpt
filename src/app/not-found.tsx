import Link from "next/link";
import { YoriMark } from "@/components/ui/icon";

/**
 * Shared 404 for unknown routes and for conversations the current user cannot
 * access. The message is deliberately identical in both cases, so the page never
 * confirms that another account's conversation exists.
 */
export default function NotFound() {
  return (
    <main className="status-page">
      <span className="brand status-brand">
        <YoriMark />
        <span>
          Yori<span className="brand-light">GPT</span>
        </span>
      </span>
      <h1>Not found</h1>
      <p>
        We couldn’t find that page or conversation. It may have been deleted, or it may
        belong to another account.
      </p>
      <div className="status-links">
        <Link href="/">Back to chat</Link>
        <Link href="/login">Sign in</Link>
      </div>
    </main>
  );
}
