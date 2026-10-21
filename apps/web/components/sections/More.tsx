import { ConnectCard } from "../ConnectCard";
import { Faq } from "./Faq";
import { Follow } from "./Follow";
import "./more.css";

/** Under the close: connecting your agent and the common questions side by side, then the email signup. */
export function More() {
  return (
    <section className="more" aria-label="Connect, questions and news">
      <div className="more-in">
        <ConnectCard />
        <Faq />
      </div>
      <Follow />
    </section>
  );
}
