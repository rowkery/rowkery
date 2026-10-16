import { KeyIcon, LockIcon, UserIcon } from "../Icons";

const POINTS = [
  [UserIcon, "No account", "Download it, connect your database and start working. There’s nothing to sign up for.", "user"],
  [KeyIcon, "Keychain", "Passwords are stored in your Mac’s Keychain.", "key"],
  [LockIcon, "SSH tunnels and TLS", "Secure connections to remote databases.", "lock"],
] as const;

/** Security first (2026-10-16, was "No account needed"): three small cards, each icon with a small loop. */
export function Security() {
  return (
    <section className="sec" id="security">
      <div className="wrap">
        <h2 className="h2 reveal">Security first</h2>
        <p className="lead reveal">Your data goes straight from your Mac to your database, with no server of ours in between.</p>
        <div className="grid three">
          {POINTS.map(([Icon, title, text, motion]) => (
            <article className="card mini reveal" key={title}>
              <div className={`ic m-${motion}`}>
                <Icon />
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
