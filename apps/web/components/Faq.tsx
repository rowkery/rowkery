/** The common questions, all closed to start. */
const QUESTIONS = [
  ["Do I need an AI agent?", "No. Everything works on your own, from the keyboard."],
  ["Which databases does it support?", "Postgres, including Google Cloud SQL, and SQLite. More are on the way."],
  ["Does my data go through your servers?", "No. Rowkery connects straight from your Mac to your database."],
  ["Which agents work with it?", "Claude Code and Claude Desktop in one click. Cursor and other MCP clients with a short config entry."],
  ["Why does macOS warn me the first time?", "The beta isn’t signed by Apple yet. Run the line under Get Rowkery once before the first launch, and it opens like any other app."],
];

export function Faq() {
  return (
    <section className="sec wrap" id="faq">
      <div className="narrow">
        <h2 className="rv">Questions</h2>
        <div className="faq rv">
          {QUESTIONS.map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <span className="pm" aria-hidden="true">
                  +
                </span>
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
