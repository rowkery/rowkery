/** The common questions, one open to start. */
const QUESTIONS = [
  ["Do I need an AI agent?", "No. Everything works on your own, from the keyboard."],
  ["Does my data go through your servers?", "No. Rowkery connects straight from your Mac to your database."],
  ["Which agents work with it?", "Claude Code and Claude Desktop in one click. Cursor and other MCP clients with a short config entry."],
  ["Why does macOS warn me the first time?", "The alpha isn’t signed by Apple yet. Run the one line under Get Rowkery once before the first launch, and it opens like any other app."],
];

export function Faq() {
  return (
    <div className="faq" id="faq">
      <h2>Common questions</h2>
      {QUESTIONS.map(([q, a], i) => (
        <details key={q} open={i === 0}>
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
  );
}
