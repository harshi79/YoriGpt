import type { Metadata } from "next";
import Link from "next/link";
import { YoriMark } from "@/components/ui/icon";
import { PetPlayground } from "@/features/pets/components/pet-playground";
import { listAvailablePets } from "@/features/pets/catalog";
import { PET_STATES } from "@/features/pets/state";
import { getCurrentUser } from "@/server/auth/session";
import { loadCompanion } from "@/server/pets/service";

export const metadata: Metadata = {
  title: "Pet Playground · YoriGPT",
  description: "A development preview of the YoriGPT pet framework.",
};

/**
 * The pet framework, exercised on its own: the catalog, the renderer, and the state
 * vocabulary.
 *
 * The page is public, but the pet *selection* is personal. A signed-in visitor is
 * shown their stored companion (read server-side from
 * `user_preferences.selectedPetKey`) and choosing one saves it to their account via
 * `PUT /api/settings/pet`. An anonymous visitor still gets the full playground, but
 * the choice stays in this tab and never touches the database. Mood and size remain
 * local demo controls for everyone. It reuses the settings page's shell and cards so
 * it looks like the rest of the app without inventing a second visual language.
 */
export default async function PetsPage() {
  const user = await getCurrentUser();
  const companion = await loadCompanion(user);

  return (
    <div className="settings-shell">
      <header className="settings-topbar">
        <Link className="brand" href="/">
          <YoriMark />
          <span>
            Yori<span className="brand-light">GPT</span>
          </span>
        </Link>
        <Link className="settings-topbar-link" href="/">
          Back to chat
        </Link>
      </header>
      <main className="settings-main">
        <div className="settings-heading">
          <h1>Pet Playground</h1>
          <p className="settings-lead">
            {user
              ? "Choose the companion that keeps you company."
              : "An early look at the pet framework. Sign in to keep a companion."}
          </p>
        </div>

        <section className="settings-card" aria-labelledby="pets-stage-heading">
          <h2 id="pets-stage-heading">Companions</h2>
          <p className="settings-card-intro">
            {user
              ? "Choose a pet, an appearance, a personality, and a mood to see how it is drawn. Your pet, appearance, and personality are saved to your account; mood and size are just for this visit."
              : "Choose a pet, an appearance, a personality, and a mood to see how it is drawn. The choice stays on this device until you sign in."}
          </p>
          <PetPlayground
            pets={listAvailablePets()}
            initialPetId={companion.pet}
            initialAppearanceId={companion.appearance}
            initialPersonalityId={companion.personality}
            canPersist={Boolean(user)}
          />
          <p className="settings-note">
            Supported moods: {PET_STATES.join(", ")}. Movement is reduced
            automatically when your device asks for reduced motion, and every mood is
            still shown as a pose.
          </p>
        </section>
      </main>
    </div>
  );
}
