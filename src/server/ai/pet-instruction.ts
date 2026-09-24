import "server-only";
import { findPersonalityForPet, findPet } from "@/features/pets/catalog";
import type {
  PetPersonalityMotionLevel,
  PetPersonalityTrait,
} from "@/features/pets/types";
import { isAiPetContext, toAiPetContext, type AiPetContext } from "./pet-context";

/**
 * The one boundary from the existing, server-resolved companion context to model
 * instructions. The providers receive only an ordinary system message: no pet
 * objects, preference rows, account data, visual states, or provider-specific fields.
 */
export type PetAiInstruction = { readonly systemInstruction: string };

/** Code-owned interpretations of the catalog's *traits*, not a second personality list. */
const TRAIT_GUIDANCE: Record<PetPersonalityTrait, string> = {
  gentle: "Be gentle and supportive.",
  energetic: "Bring a little energy without sacrificing clarity.",
  inquisitive:
    "Show genuine interest, explain useful connections, and ask a relevant follow-up only when helpful; never invent facts.",
  restful: "Use a relaxed, low-energy tone, but still answer fully and clearly.",
  sociable: "Sound warm and approachable.",
  independent: "Stay composed and clear without unnecessary chatter.",
};

/** Movement hints affect expressiveness only; resting *states* belong to the visual engine. */
const MOTION_GUIDANCE: Record<PetPersonalityMotionLevel, string> = {
  low: "Avoid unnecessary excitement.",
  medium: "Keep the pacing measured rather than exaggerated.",
  high: "Occasional harmless playful phrasing is welcome; do not turn every answer into a joke.",
};

const TASK_FIRST =
  "Answer the user's request accurately and usefully, including technical and factual details. " +
  "Follow higher-priority and safety instructions; style must never override the task. " +
  "Keep the tone subtle: do not claim to be an animal, name a personality, or force a catchphrase.";

/**
 * Accept only the Task 21 projection for a real, available pet and a personality
 * that pet offers. Recheck its metadata against the *same catalog* that resolved it:
 * a forged object with a known id but injected name, traits, or hints must not be
 * treated as a source of system instructions. No string from the context is copied
 * into the result; only the fixed trait/hint interpretations above are used.
 *
 * A broken internal contract fails closed with a generic error rather than making
 * an arbitrary text field a prompt or silently switching the user's personality.
 * The ordinary resolver is total and supplies a valid catalog default if needed.
 */
export function buildPetAiInstruction(context: AiPetContext): PetAiInstruction {
  if (!isAiPetContext(context)) throw new Error("Invalid AI pet context.");

  const pet = findPet(context.pet.id);
  const personality = pet?.available ? findPersonalityForPet(pet.id, context.personality.id) : null;
  if (!pet || !personality) throw new Error("Invalid AI pet context.");

  const expected = toAiPetContext(pet, personality);
  const sameTraits =
    context.personality.traits.length === expected.personality.traits.length &&
    context.personality.traits.every((trait, index) => trait === expected.personality.traits[index]);
  const sameHints =
    context.personality.hints?.restingState === expected.personality.hints?.restingState &&
    context.personality.hints?.motionLevel === expected.personality.hints?.motionLevel;
  if (
    context.pet.name !== expected.pet.name ||
    context.personality.name !== expected.personality.name ||
    !sameTraits ||
    !sameHints
  )
    throw new Error("Invalid AI pet context.");

  const guidance: string[] = context.personality.traits.map((trait) => TRAIT_GUIDANCE[trait]);
  const motion = context.personality.hints?.motionLevel;
  if (motion) guidance.push(MOTION_GUIDANCE[motion]);
  return { systemInstruction: [TASK_FIRST, ...guidance].join(" ") };
}
