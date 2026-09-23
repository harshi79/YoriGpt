import { Icon, YoriMark, type IconName } from "../ui/icon";

const suggestions: {
  icon: IconName;
  title: string;
  detail: string;
  draft: string;
  tone: string;
}[] = [
  {
    icon: "edit",
    title: "Write something",
    detail: "Find the words you’re looking for",
    draft: "Help me find the right words for an idea I’m working on.",
    tone: "mint",
  },
  {
    icon: "idea",
    title: "Explore an idea",
    detail: "Follow a spark of curiosity",
    draft: "I’d like to explore a new idea. Where should I start?",
    tone: "amber",
  },
  {
    icon: "plan",
    title: "Make a plan",
    detail: "Turn your next step into a first step",
    draft: "Help me break a big goal into smaller, manageable steps.",
    tone: "blue",
  },
  {
    icon: "book",
    title: "Learn something",
    detail: "Make the complicated feel simple",
    draft: "Help me understand something new, one step at a time.",
    tone: "lilac",
  },
];

export function EmptyState({
  onChoosePrompt,
}: {
  onChoosePrompt: (draft: string) => void;
}) {
  return (
    <section className="empty-state" aria-labelledby="welcome-heading">
      <div className="welcome-symbol">
        <YoriMark />
        <span className="symbol-spark" />
      </div>
      <p className="eyebrow">A fresh conversation. A new possibility.</p>
      <h1 id="welcome-heading">
        Where will your
        <br />
        <span>curiosity take you?</span>
      </h1>
      <p className="welcome-description">
        A space to think clearly, create freely, and figure things out.
        <br className="desktop-break" /> Start with a thought. See where it
        goes.
      </p>
      <div className="suggestions" aria-label="Draft starters">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.title}
            type="button"
            className="suggestion-card"
            onClick={() => onChoosePrompt(suggestion.draft)}
            aria-label={`${suggestion.title} — add a draft`}
          >
            <span className={`suggestion-icon ${suggestion.tone}`}>
              <Icon name={suggestion.icon} />
            </span>
            <strong>{suggestion.title}</strong>
            <span className="suggestion-detail">{suggestion.detail}</span>
            <Icon name="arrowRight" className="suggestion-arrow" />
          </button>
        ))}
      </div>
      <p className="starter-hint">
        A little inspiration, if you need it. Select a card to start a draft.
      </p>
    </section>
  );
}
