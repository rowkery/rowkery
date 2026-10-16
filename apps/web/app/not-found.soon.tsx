import { ComingSoon } from "@/components/ComingSoon";
import { metadata, viewport } from "./(soon)/layout.soon";
import { soonSans } from "./soon-font";
import "./soon.css";

export { metadata, viewport };

/**
 * Every other address (out/404.html) shows the same page while ROWKERY_COMING_SOON is on.
 * The build has two roots (the page's, and the real site's under its key), so this one
 * carries its own <html>.
 */
export default function NotFound() {
  return (
    <html lang="en" className={soonSans.variable}>
      <body>
        <ComingSoon />
      </body>
    </html>
  );
}
