"use client";

import { useState } from "react";
import { PetRenderer } from "./pet-renderer";
import { petTreatment } from "../animations";
import {
  listAppearancesForPet,
  listPersonalitiesForPet,
  resolveAppearanceForPet,
  resolvePersonalityForPet,
  resolvePet,
} from "../catalog";
import {
  requestPetAppearance,
  requestPetPersonality,
  requestPetSelection,
} from "../client";
import { INITIAL_PET_STATE, PET_STATES, PET_STATE_LABELS, type PetState } from "../state";
import {
  DEFAULT_PET_SIZE,
  PET_SIZES,
  PET_SIZE_LABELS,
  type PetDefinition,
  type PetSize,
} from "../types";

type Props = {
  /** The available pets the server offers. */
  pets: PetDefinition[];
  /** The signed-in user's stored pet, when there is one. */
  initialPetId?: string;
  /** The signed-in user's stored appearance, resolved for `initialPetId`. */
  initialAppearanceId?: string;
  /** The signed-in user's stored personality, resolved for `initialPetId`. */
  initialPersonalityId?: string;
  /** True when a choice should be saved to the account; false keeps it local. */
  canPersist?: boolean;
};

/**
 * The `/pets` playground: pick a pet, a look, a personality, a mood, and a size.
 *
 * State and size are always local demo controls. The *pet*, its *appearance*, and its
 * *personality* are persisted for a signed-in user through the three sibling routes
 * under `/api/settings/pet`; an anonymous visitor keeps every choice in this tab only
 * and never writes to the database. A save is optimistic — the new value is drawn
 * immediately, confirmed by the server's answer, and rolled back with a short note if
 * it fails — so a tiny preference never shows a spinner.
 *
 * The appearance and personality controls list only what the selected pet offers, so
 * switching pets silently resolves a choice the new pet does not have back to its own
 * default rather than leaving an invalid selection on screen.
 *
 * The controls are ordinary buttons (keyboard operable, `aria-pressed`). The mood
 * caption and the personality line are plain text and **not** live regions, so
 * changing either never interrupts a screen reader and no meaning rides on animation.
 */
export function PetPlayground({
  pets,
  initialPetId,
  initialAppearanceId,
  initialPersonalityId,
  canPersist = false,
}: Props) {
  const first = resolvePet(initialPetId ?? pets[0]?.id ?? "").id;
  const [petId, setPetId] = useState(first);
  // Always valid for the starting pet: an unknown or other-pet id resolves to default.
  const [appearanceId, setAppearanceId] = useState(
    () => resolveAppearanceForPet(first, initialAppearanceId).id,
  );
  // A plain string on purpose, exactly like `appearanceId`: the resolved catalog id
  // starts narrow, but the value the server echoes back is an ordinary string.
  const [personalityId, setPersonalityId] = useState<string>(
    () => resolvePersonalityForPet(first, initialPersonalityId).id,
  );
  const [state, setState] = useState<PetState>(INITIAL_PET_STATE);
  const [size, setSize] = useState<PetSize>(DEFAULT_PET_SIZE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Always a real, available pet: an unknown id resolves instead of rendering nothing.
  const pet = resolvePet(petId);
  const appearance = resolveAppearanceForPet(pet.id, appearanceId);
  const appearances = listAppearancesForPet(pet.id);
  const personality = resolvePersonalityForPet(pet.id, personalityId);
  const personalities = listPersonalitiesForPet(pet.id);
  const treatment = petTreatment(state);

  const choosePet = async (id: string) => {
    if (id === petId || saving) return;
    setError(null);

    // Anything the new pet does not offer — an appearance or a personality — drops
    // back to that pet's own default.
    const nextAppearance = resolveAppearanceForPet(id, appearanceId).id;
    const nextPersonality = resolvePersonalityForPet(id, personalityId).id;

    // Anonymous (or a refused save) stays local-only; nothing reaches the database.
    if (!canPersist) {
      setPetId(id);
      setAppearanceId(nextAppearance);
      setPersonalityId(nextPersonality);
      return;
    }

    const previous = petId;
    const previousAppearance = appearanceId;
    const previousPersonality = personalityId;
    setPetId(id);
    setAppearanceId(nextAppearance);
    setPersonalityId(nextPersonality);
    setSaving(true);

    const result = await requestPetSelection(id);
    setSaving(false);

    if (result.ok) {
      // Keep the server's own answer on screen.
      setPetId(result.pet);
      return;
    }
    setPetId(previous);
    setAppearanceId(previousAppearance);
    setPersonalityId(previousPersonality);
    setError(result.message);
  };

  const chooseAppearance = async (id: string) => {
    if (id === appearanceId || saving) return;
    setError(null);

    // Anonymous keeps the appearance in this tab only.
    if (!canPersist) {
      setAppearanceId(id);
      return;
    }

    const previous = appearanceId;
    setAppearanceId(id);
    setSaving(true);

    const result = await requestPetAppearance(id);
    setSaving(false);

    if (result.ok) {
      setAppearanceId(result.appearance);
      return;
    }
    setAppearanceId(previous);
    setError(result.message);
  };

  const choosePersonality = async (id: string) => {
    if (id === personalityId || saving) return;
    setError(null);

    // Anonymous keeps the personality in this tab only.
    if (!canPersist) {
      setPersonalityId(id);
      return;
    }

    const previous = personalityId;
    setPersonalityId(id);
    setSaving(true);

    const result = await requestPetPersonality(id);
    setSaving(false);

    if (result.ok) {
      setPersonalityId(result.personality);
      return;
    }
    setPersonalityId(previous);
    setError(result.message);
  };

  const hint = error
    ? error
    : saving
      ? "Saving…"
      : canPersist
        ? "Your companion is saved to your account."
        : "Sign in to keep your companion between visits.";

  return (
    <div className="pets-playground">
      <div className="pets-stage">
        <PetRenderer
          pet={pet}
          appearance={appearance.id}
          personality={personality.id}
          state={state}
          size={size}
        />
        <p className="pets-caption">
          <strong>{pet.name}</strong> is {PET_STATE_LABELS[state].toLowerCase()} —{" "}
          {treatment.caption}
        </p>
        <p className="pets-description">{pet.description}</p>
        {/* The chosen personality, stated in plain text. Not a live region, so picking
            one never interrupts a screen reader; it drives no animation yet. */}
        <p className="pets-personality">
          <strong>{personality.name}</strong> — {personality.description}
        </p>
      </div>

      <div className="pets-controls">
        <div className="pets-control-group" role="group" aria-label="Choose a pet">
          <span className="pets-control-label">Pet</span>
          <div className="pets-button-row">
            {pets.map((option) => (
              <button
                key={option.id}
                type="button"
                className="pets-choice"
                aria-pressed={option.id === pet.id}
                disabled={saving}
                onClick={() => void choosePet(option.id)}
              >
                <span className="pets-choice-name">{option.name}</span>
                <span className="pets-choice-detail">{option.species}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="pets-control-group" role="group" aria-label="Choose an appearance">
          <span className="pets-control-label">Appearance</span>
          <div className="pets-button-row">
            {appearances.map((option) => (
              <button
                key={option.id}
                type="button"
                className="pets-choice"
                aria-pressed={option.id === appearance.id}
                disabled={saving}
                onClick={() => void chooseAppearance(option.id)}
                title={option.description}
              >
                <span className="pets-choice-name">{option.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="pets-control-group" role="group" aria-label="Choose a personality">
          <span className="pets-control-label">Personality</span>
          <div className="pets-button-row">
            {personalities.map((option) => (
              <button
                key={option.id}
                type="button"
                className="pets-choice"
                aria-pressed={option.id === personality.id}
                disabled={saving}
                onClick={() => void choosePersonality(option.id)}
                title={option.description}
              >
                <span className="pets-choice-name">{option.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="pets-control-group" role="group" aria-label="Pet state">
          <span className="pets-control-label">State</span>
          <div className="pets-button-row">
            {PET_STATES.map((option) => (
              <button
                key={option}
                type="button"
                className="pets-choice"
                aria-pressed={option === state}
                onClick={() => setState(option)}
              >
                {PET_STATE_LABELS[option]}
              </button>
            ))}
          </div>
        </div>

        <div className="pets-control-group" role="group" aria-label="Pet size">
          <span className="pets-control-label">Size</span>
          <div className="pets-button-row">
            {PET_SIZES.map((option) => (
              <button
                key={option}
                type="button"
                className="pets-choice"
                aria-pressed={option === size}
                onClick={() => setSize(option)}
              >
                {PET_SIZE_LABELS[option]}
              </button>
            ))}
          </div>
        </div>

        <p className={`settings-hint ${error ? "is-error" : ""}`} role={error ? "alert" : undefined}>
          {hint}
        </p>
      </div>
    </div>
  );
}
