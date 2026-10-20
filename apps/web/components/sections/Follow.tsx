"use client";

import { useState } from "react";
import { KIT_FORM_ID, KIT_FORM_URL } from "@/lib/site";
import { Pg } from "../Pg";
import "./follow.css";

/**
 * Under Try Rowkery, for people not ready to install it: leave an email for news of what ships.
 * The form posts straight to Kit (the site has no server), so without scripts it still works
 * and Kit shows its own page; with them it stays here and says to confirm by email.
 */
export function Follow() {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  if (!KIT_FORM_ID) return null;

  async function subscribe(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setState("sending");
    try {
      const res = await fetch(KIT_FORM_URL, { method: "POST", body: new FormData(form), headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      setState(res.ok && body.status !== "failed" ? "sent" : "failed");
    } catch {
      // Kit never answered (a blocker, or offline): post the plain form and let Kit's page say.
      form.submit();
    }
  }

  return (
    <section className="band follow" data-follow>
      <div className="follow-in">
        <Pg prop="letter" className="peek2" />
        <div className="card follow-card">
          <div>
            <h3>Not ready to try it yet?</h3>
            <p>Leave your email and I’ll write when something new ships. No spam, and you can unsubscribe in one click.</p>
          </div>
          {state === "sent" ? (
            <p className="follow-sent" role="status" data-follow-state="sent">
              Almost there. Check your inbox and tap the link to confirm.
            </p>
          ) : (
            <div className="follow-field">
              <form className="follow-form" action={KIT_FORM_URL} method="post" onSubmit={subscribe}>
                <input type="email" name="email_address" onInput={() => state === "failed" && setState("idle")} required placeholder="you@example.com" aria-label="Email address" autoComplete="email" />
                <button className="btn ink" type="submit" disabled={state === "sending"}>
                  Subscribe
                </button>
              </form>
              {state === "failed" && (
                <p className="follow-failed" role="alert" data-follow-state="failed">
                  That didn’t go through. Check the address and try again.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
