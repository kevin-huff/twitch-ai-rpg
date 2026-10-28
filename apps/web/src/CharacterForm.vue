<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import type { CardGenerationResponse, CharacterCardDefinition, FieldGenerationCharacterContext, FieldGenerationRequest, FieldGenerationResponse, PictureIdResponse, PortraitDetails } from '@rpg/contracts';
import CardGenerator from './CardGenerator.vue';
import PortraitGenerator from './PortraitGenerator.vue';
import FieldGenerator from './FieldGenerator.vue';
import { characterFieldContext } from './field-context';
const card = defineModel<CharacterCardDefinition>({ required: true });
const characterContext = computed(() => characterFieldContext(card.value));
const props = withDefaults(defineProps<{ disabled?: boolean; generationEnabled?: boolean; generationContext?: string | number; premise?: string; premiseLabel?: string; instructions?: string; generate?: (request: FieldGenerationRequest) => Promise<FieldGenerationResponse>; generateCard?: (input: { prompt: string; keepFilled: boolean; current: FieldGenerationCharacterContext }) => Promise<CardGenerationResponse>; cardGenerationNote?: string; picturesEnabled?: boolean; generatePortrait?: (details: PortraitDetails) => Promise<PictureIdResponse>; portraitUrl?: (imageId: string) => string }>(), { generationEnabled: false, generationContext: 'character-form' });
const description = defineModel<string>('description', { default: '' });
const usedPrompt = ref('');
const blankCardContext = () => characterFieldContext({ schemaVersion: 1, displayName: card.value.displayName, pronouns: '', appearance: '', personality: '', backstory: '', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, specialty: '', flaw: '', possessions: [], connection: '', secret: '', extensions: {} });
async function generateWholeCard(input: { prompt: string; keepFilled: boolean }) {
  const response = await props.generateCard!({ ...input, current: blankCardContext() });
  usedPrompt.value = input.prompt.trim();
  return response;
}
function applyGeneratedCard(response: CardGenerationResponse) {
  card.value = { ...response.card, possessions: Array.from({ length: Math.max(3, response.card.possessions.length) }, (_, index) => response.card.possessions[index] ?? ''), extensions: card.value.extensions, portraitId: card.value.portraitId };
}
function undoGeneratedCard(previous: CharacterCardDefinition) {
  card.value = { ...previous, portraitId: card.value.portraitId };
}
function usePortrait(imageId: string) {
  card.value.portraitId = imageId;
}
function removePortrait() {
  delete card.value.portraitId;
}
watch(() => props.generationContext, () => {
  usedPrompt.value = '';
  description.value = '';
});
const showPortrait = computed(() => Boolean(props.picturesEnabled && props.generatePortrait && props.portraitUrl && (card.value.appearance?.trim() || description.value.trim() || card.value.portraitId)));
const showDescriptionNote = computed(() => Boolean(card.value.appearance?.trim() && description.value.trim() && description.value.trim() !== usedPrompt.value));
const helpPrefix = useId();
const helpId = (key: string) => `${helpPrefix}-help-${key}`;
const traitHelp = { force: 'Added to dice checks for strength, endurance, and direct physical action.', finesse: 'Added to dice checks for agility, stealth, and precise work.', wits: 'Added to dice checks for investigation, knowledge, and technical work.', presence: 'Added to dice checks for persuasion, deception, and performance.' };
const traits = ['force', 'finesse', 'wits', 'presence'] as const;
const details = [
  { key: 'appearance', label: 'Appearance', help: 'Shown to the cast and used by the AI when describing this character.' },
  { key: 'personality', label: 'Personality' },
  { key: 'backstory', label: 'Backstory' },
  { key: 'specialty', label: 'Specialty', help: 'Defines a specific capability for action planning; it does not automatically add the +1 Edge bonus.' },
  { key: 'flaw', label: 'Flaw' },
  { key: 'connection', label: 'Connection to the party' },
  { key: 'secret', label: 'Private secret · owner and director only', help: 'Kept for the owner and director. It is not shown on public cards or sent to the AI for live narration.' },
] as const;
</script>

<template>
  <fieldset :disabled="disabled" class="character-form">
    <div class="generated-field name-field"><label><span :class="{ 'field-label': generationEnabled }">Character name</span><input v-model="card.displayName" data-testid="card-name" maxlength="80" required></label><FieldGenerator :generate="generate" :instructions="instructions" :character-context="characterContext" v-if="generationEnabled" :premise="premise" :premise-label="premiseLabel" class="field-ai" field="character.displayName" v-model="card.displayName" :context-key="generationContext" :disabled="disabled" /></div>
    <div class="describe-field"><label>Describe your character<textarea v-model="description" data-testid="card-description" rows="3" maxlength="1000" /></label><p v-if="showDescriptionNote" class="field-help" data-testid="card-description-note">This box is only used by Write my card.</p></div>
    <CardGenerator v-if="generationEnabled && generateCard" :card="card" :prompt="description" :context-key="generationContext" :disabled="disabled" :context-note="cardGenerationNote" :generate="generateWholeCard" @apply="applyGeneratedCard" @undo="undoGeneratedCard" />
    <p class="field-help" data-testid="card-name-only">Only a name is needed.</p>
    <PortraitGenerator v-if="showPortrait" :name="card.displayName" :portrait-id="card.portraitId" :details="{ appearance: card.appearance?.trim() ? card.appearance : description.trim(), role: card.specialty, pronouns: card.pronouns, name: card.displayName }" :context-key="generationContext" :disabled="disabled" :image-url="portraitUrl!" :generate="generatePortrait!" @use="usePortrait" @remove="removePortrait" />
    <details class="card-more" data-testid="card-more">
      <summary>More about your character</summary>
      <div class="generated-field"><label><span :class="{ 'field-label': generationEnabled }">Pronouns</span><input v-model="card.pronouns" maxlength="80"></label><FieldGenerator :generate="generate" :instructions="instructions" :character-context="characterContext" v-if="generationEnabled" :premise="premise" :premise-label="premiseLabel" class="field-ai" field="character.pronouns" v-model="card.pronouns" :context-key="generationContext" :disabled="disabled" /></div>
      <div v-for="detail in details" :key="detail.key" class="generated-field"><label><span :class="{ 'field-label': generationEnabled }">{{ detail.label }}</span><textarea :aria-describedby="'help' in detail ? helpId(detail.key) : undefined" v-model="card[detail.key]" :data-testid="`card-${detail.key}`" rows="2" /></label><p v-if="'help' in detail" :id="helpId(detail.key)" class="field-help">{{ detail.help }}</p><FieldGenerator :generate="generate" :instructions="instructions" :character-context="characterContext" v-if="generationEnabled" :premise="premise" :premise-label="premiseLabel" class="field-ai" :field="`character.${detail.key}`" v-model="card[detail.key]" :context-key="generationContext" :disabled="disabled" /></div>
      <p :id="helpId('allocation')" class="muted">Assign +2, +1, +1, and +0 across the four traits.</p>
      <div class="field-grid"><div v-for="trait in traits" :key="trait"><label>{{ trait }}<select :aria-describedby="`${helpId(trait)} ${helpId('allocation')}`" v-model.number="card.traits[trait]" :data-testid="`card-trait-${trait}`"><option :value="0">+0</option><option :value="1">+1</option><option :value="2">+2</option></select></label><p :id="helpId(trait)" class="field-help">{{ traitHelp[trait] }}</p></div></div>
      <div class="field-grid"><div v-for="index in 3" :key="index" class="generated-field"><label><span :class="{ 'field-label': generationEnabled }">Possession {{ index }}</span><input :aria-describedby="helpId(`possession-${index}`)" v-model="card.possessions[index - 1]" maxlength="160"></label><p :id="helpId(`possession-${index}`)" class="field-help">An item available to this character during action planning. Equipment alone does not add a dice bonus.</p><FieldGenerator :generate="generate" :instructions="instructions" :character-context="characterContext" v-if="generationEnabled" :premise="premise" :premise-label="premiseLabel" class="field-ai" field="character.possession" :model-value="card.possessions[index - 1] ?? ''" :context-key="`${generationContext}:possession:${index}`" :disabled="disabled" @update:model-value="card.possessions[index - 1] = $event" /></div></div>
    </details>
  </fieldset>
</template>

<style scoped>
.character-form { border: 0; padding: 0; margin: 0; min-width: 0; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.generated-field { position: relative; min-width: 0; }
.character-form > .generated-field, .describe-field { margin-bottom: 16px; }
.card-more { margin-top: 16px; }
.card-more > summary { margin-bottom: 16px; }
.card-more > .generated-field { margin-bottom: 16px; }
.field-label { min-height: 44px; padding-right: 148px; display: flex; align-items: center; }
.field-ai { position: absolute; top: 0; right: 0; }
@media (max-width: 600px) { .field-grid { grid-template-columns: 1fr; } }
</style>
