<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import type { CardGenerationResponse, CharacterCardDefinition, FieldGenerationCharacterContext, FieldGenerationRequest, FieldGenerationResponse, PictureIdResponse, PortraitDetails } from '@rpg/contracts';
import CardGenerator from './CardGenerator.vue';
import PortraitGenerator from './PortraitGenerator.vue';
import FieldGenerator from './FieldGenerator.vue';
import { characterFieldContext } from './field-context';
const card = defineModel<CharacterCardDefinition>({ required: true });
const pronounsPending = defineModel<boolean>('pronounsPending', { default: false });
const characterContext = computed(() => characterFieldContext(card.value));
const props = withDefaults(defineProps<{ disabled?: boolean; generationEnabled?: boolean; generationContext?: string | number; premise?: string; premiseLabel?: string; instructions?: string; generate?: (request: FieldGenerationRequest) => Promise<FieldGenerationResponse>; generateCard?: (input: { prompt: string; keepFilled: boolean; current: FieldGenerationCharacterContext }) => Promise<CardGenerationResponse>; cardGenerationNote?: string; picturesEnabled?: boolean; generatePortrait?: (details: PortraitDetails) => Promise<PictureIdResponse>; portraitUrl?: (imageId: string) => string }>(), { generationEnabled: false, generationContext: 'character-form' });
let suggestedPronouns: string | null = null;
const generateWholeCard = (input: { prompt: string; keepFilled: boolean }) => props.generateCard!({ ...input, current: characterFieldContext(card.value) });
function applyGeneratedCard(response: CardGenerationResponse) {
  suggestedPronouns = response.pronounsSuggested ? response.card.pronouns : null;
  pronounsPending.value = response.pronounsSuggested;
  card.value = { ...response.card, possessions: Array.from({ length: Math.max(3, response.card.possessions.length) }, (_, index) => response.card.possessions[index] ?? ''), extensions: card.value.extensions, portraitId: card.value.portraitId };
}
function undoGeneratedCard(previous: CharacterCardDefinition) {
  suggestedPronouns = null;
  pronounsPending.value = false;
  card.value = { ...previous, portraitId: card.value.portraitId };
}
function usePortrait(imageId: string) {
  card.value.portraitId = imageId;
}
function removePortrait() {
  delete card.value.portraitId;
}
function keepSuggestedPronouns() {
  suggestedPronouns = null;
  pronounsPending.value = false;
}
watch(() => card.value.pronouns, value => {
  if (pronounsPending.value && suggestedPronouns !== null && value !== suggestedPronouns) keepSuggestedPronouns();
});
const helpPrefix = useId();
const helpId = (key: string) => `${helpPrefix}-help-${key}`;
const traitHelp = { force: 'Added to dice checks for strength, endurance, and direct physical action.', finesse: 'Added to dice checks for agility, stealth, and precise work.', wits: 'Added to dice checks for investigation, knowledge, and technical work.', presence: 'Added to dice checks for persuasion, deception, and performance.' };
const traits = ['force', 'finesse', 'wits', 'presence'] as const;
const details = [
  { key: 'appearance', label: 'Appearance', help: 'Shown to the cast after approval and used by the AI when describing this character.' },
  { key: 'personality', label: 'Personality', help: 'Roleplaying reference for the owner and director: habits, temperament, and how you choose to act.' },
  { key: 'backstory', label: 'Backstory', help: 'Background reference for the owner and director, such as past events and important ties.' },
  { key: 'specialty', label: 'Specialty', help: 'Defines a specific capability for action planning; it does not automatically add the +1 Edge bonus.' },
  { key: 'flaw', label: 'Flaw', help: 'A voluntary roleplaying complication for the owner and director to refer to; it does not force your choices.' },
  { key: 'connection', label: 'Connection to the party', help: 'Reference for the owner and director about why this character works with the group.' },
  { key: 'secret', label: 'Private secret · owner and director only', help: 'Kept for the owner and director. It is not shown on public cards or sent to the AI for live narration.' },
] as const;
</script>

<template>
  <fieldset :disabled="disabled" class="character-form">
    <CardGenerator v-if="generationEnabled && generateCard" :card="card" :context-key="generationContext" :disabled="disabled" :context-note="cardGenerationNote" :generate="generateWholeCard" @apply="applyGeneratedCard" @undo="undoGeneratedCard" />
    <PortraitGenerator v-if="picturesEnabled && generatePortrait && portraitUrl" :name="card.displayName" :portrait-id="card.portraitId" :details="{ appearance: card.appearance, role: card.specialty, pronouns: card.pronouns, name: card.displayName }" :context-key="generationContext" :disabled="disabled" :image-url="portraitUrl" :generate="generatePortrait" @use="usePortrait" @remove="removePortrait" />
    <div class="field-grid"><div class="generated-field"><label><span :class="{ 'field-label': generationEnabled }">Character name</span><input :aria-describedby="helpId('name')" v-model="card.displayName" data-testid="card-name" maxlength="80" required></label><p :id="helpId('name')" class="field-help">The name used on the approved public card, player seat, and dialogue captions.</p><FieldGenerator :generate="generate" :instructions="instructions" :character-context="characterContext" v-if="generationEnabled" :premise="premise" :premise-label="premiseLabel" class="field-ai" field="character.displayName" v-model="card.displayName" :context-key="generationContext" :disabled="disabled" /></div><div class="generated-field"><label><span :class="{ 'field-label': generationEnabled }">Pronouns</span><input :aria-describedby="helpId('pronouns')" v-model="card.pronouns" maxlength="80"></label><p :id="helpId('pronouns')" class="field-help">Optional pronouns that guide how the AI refers to this character.</p><div v-if="pronounsPending" class="pronouns-suggested"><p data-testid="suggested-pronouns-notice" role="status">The AI suggested these pronouns. Keep them or change them.</p><button type="button" class="secondary" data-testid="keep-suggested-pronouns" @click="keepSuggestedPronouns">Keep these pronouns</button></div><FieldGenerator :generate="generate" :instructions="instructions" :character-context="characterContext" v-if="generationEnabled" :premise="premise" :premise-label="premiseLabel" class="field-ai" field="character.pronouns" v-model="card.pronouns" :context-key="generationContext" :disabled="disabled" /></div></div>
    <div v-for="detail in details" :key="detail.key" class="generated-field"><label><span :class="{ 'field-label': generationEnabled }">{{ detail.label }}</span><textarea :aria-describedby="helpId(detail.key)" v-model="card[detail.key]" :data-testid="`card-${detail.key}`" rows="2" /></label><p :id="helpId(detail.key)" class="field-help">{{ detail.help }}</p><FieldGenerator :generate="generate" :instructions="instructions" :character-context="characterContext" v-if="generationEnabled" :premise="premise" :premise-label="premiseLabel" class="field-ai" :field="`character.${detail.key}`" v-model="card[detail.key]" :context-key="generationContext" :disabled="disabled" /></div>
    <p :id="helpId('allocation')" class="muted">Assign +2, +1, +1, and +0 across the four traits.</p>
    <div class="field-grid"><div v-for="trait in traits" :key="trait"><label>{{ trait }}<select :aria-describedby="`${helpId(trait)} ${helpId('allocation')}`" v-model.number="card.traits[trait]" :data-testid="`card-trait-${trait}`"><option :value="0">+0</option><option :value="1">+1</option><option :value="2">+2</option></select></label><p :id="helpId(trait)" class="field-help">{{ traitHelp[trait] }}</p></div></div>
    <div class="field-grid"><div v-for="index in 3" :key="index" class="generated-field"><label><span :class="{ 'field-label': generationEnabled }">Possession {{ index }}</span><input :aria-describedby="helpId(`possession-${index}`)" v-model="card.possessions[index - 1]" maxlength="160"></label><p :id="helpId(`possession-${index}`)" class="field-help">An item available to this character during action planning. Equipment alone does not add a dice bonus.</p><FieldGenerator :generate="generate" :instructions="instructions" :character-context="characterContext" v-if="generationEnabled" :premise="premise" :premise-label="premiseLabel" class="field-ai" field="character.possession" :model-value="card.possessions[index - 1] ?? ''" :context-key="`${generationContext}:possession:${index}`" :disabled="disabled" @update:model-value="card.possessions[index - 1] = $event" /></div></div>
  </fieldset>
</template>

<style scoped>
.character-form { border: 0; padding: 0; margin: 0; min-width: 0; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin-bottom: 1rem; }
.generated-field { position: relative; min-width: 0; }
.character-form > .generated-field { margin-bottom: 1rem; }
.field-label { min-height: 2.75rem; padding-right: 8rem; display: flex; align-items: center; }
.pronouns-suggested { margin: 0 0 .5rem; padding: .5rem .7rem; border-left: 3px solid var(--teal); background: var(--panel); }
.pronouns-suggested p { margin: 0 0 .4rem; font-size: .85rem; }
.field-ai { position: absolute; top: 0; right: 0; }
@media (max-width: 600px) { .field-grid { grid-template-columns: 1fr; } }
</style>
