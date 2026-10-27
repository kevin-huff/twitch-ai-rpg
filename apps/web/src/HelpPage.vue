<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { firstSteps, glossary, topics, type HelpRole, type HelpTopic } from './help/content';
import { identityPath } from './identity';

type Entry = { id: string; title: string; kind: 'topic' | 'glossary'; topicIndex: number };

const ROLE_KEY = 'story-table-help-role';
const FOLD_WORDS = 250;
const roles: Array<{ id: HelpRole; label: string }> = [
  { id: 'host', label: 'I\'m the host' },
  { id: 'player', label: 'I\'m a player' },
  { id: 'streamer', label: 'I\'m streaming' },
];
const audiences: Record<HelpRole, ReadonlyArray<HelpTopic['audience'][number]>> = {
  host: ['host', 'director', 'producer'],
  player: ['player'],
  streamer: ['streamer'],
};

function isRole(value: unknown): value is HelpRole {
  return value === 'host' || value === 'player' || value === 'streamer';
}

function readRole(): HelpRole | null {
  try {
    const stored = window.localStorage.getItem(ROLE_KEY);
    return isRole(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeRole(role: HelpRole | null) {
  try {
    if (role) window.localStorage.setItem(ROLE_KEY, role);
    else window.localStorage.removeItem(ROLE_KEY);
  } catch {
    // The choice just is not remembered.
  }
}

function wordCount(topic: HelpTopic): number {
  const text = topic.sections.flatMap(section => [section.heading, ...(section.paragraphs ?? []), ...(section.steps ?? [])]).join(' ');
  return text.split(/\s+/).filter(Boolean).length;
}

const role = ref<HelpRole | null>(readRole());
const hashId = ref('');
const opened = ref<Set<string>>(new Set());

function chooseRole(next: HelpRole) {
  role.value = role.value === next ? null : next;
  writeRole(role.value);
}

const entries = computed<Entry[]>(() => {
  const list: Entry[] = [];
  topics.forEach((topic, topicIndex) => {
    const shown = !role.value || audiences[role.value].some(audience => topic.audience.includes(audience)) || topic.id === hashId.value;
    if (shown) list.push({ id: topic.id, title: topic.title, kind: 'topic', topicIndex });
  });
  const glossaryEntry: Entry = { id: 'glossary', title: 'Glossary', kind: 'glossary', topicIndex: -1 };
  const before = list.findIndex(entry => entry.id === 'troubleshooting');
  if (before === -1) list.push(glossaryEntry);
  else list.splice(before, 0, glossaryEntry);
  return list;
});

const folded = new Set(topics.filter(topic => wordCount(topic) > FOLD_WORDS).map(topic => topic.id));
const isFolded = (id: string) => folded.has(id);

function onToggle(id: string, event: Event) {
  const next = new Set(opened.value);
  if ((event.target as HTMLDetailsElement).open) next.add(id);
  else next.delete(id);
  opened.value = next;
}

async function followHash() {
  const id = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  hashId.value = topics.some(topic => topic.id === id) ? id : '';
  const target = id === 'glossary' || hashId.value ? id : '';
  if (hashId.value) opened.value = new Set([...opened.value, id]);
  if (!target) return;
  await nextTick();
  document.getElementById(target)?.scrollIntoView?.();
}

const RETURN_KEY = 'story-table-return-path';

function sameIdentities(left: URLSearchParams, right: URLSearchParams): boolean {
  const a = left.getAll('identity');
  const b = right.getAll('identity');
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const backHref = computed(() => {
  const fallback = identityPath('/');
  let stored: string | null = null;
  try { stored = window.sessionStorage.getItem(RETURN_KEY); } catch { return fallback; }
  if (!stored || !stored.startsWith('/') || stored.startsWith('//')) return fallback;
  try {
    const target = new URL(stored, window.location.origin);
    if (target.origin !== window.location.origin) return fallback;
    if (target.pathname === '/help' || target.pathname.startsWith('/help/')) return fallback;
    if (!sameIdentities(target.searchParams, new URLSearchParams(window.location.search))) return fallback;
  } catch { return fallback; }
  return stored;
});

onMounted(() => {
  void followHash();
  window.addEventListener('hashchange', followHash);
});
onBeforeUnmount(() => window.removeEventListener('hashchange', followHash));
</script>

<template>
  <main class="help-page">
    <h1>Help</h1>
    <p class="home-link"><a :href="backHref" data-testid="help-back">Back</a></p>
    <div class="roles" role="group" aria-label="Who is reading">
      <button
        v-for="item in roles"
        :key="item.id"
        type="button"
        :class="{ secondary: role !== item.id }"
        :aria-pressed="role === item.id ? 'true' : 'false'"
        :data-testid="`help-role-${item.id}`"
        @click="chooseRole(item.id)"
      >{{ item.label }}</button>
    </div>
    <aside v-if="role" class="panel" data-testid="help-first-steps">
      <h2>Do this first</h2>
      <ol>
        <li v-for="(step, index) in firstSteps[role]" :key="index">{{ step }}</li>
      </ol>
    </aside>
    <nav class="panel" aria-label="Help contents">
      <h2>Contents</h2>
      <ul class="contents">
        <li v-for="entry in entries" :key="entry.id"><a :href="identityPath(`/help#${entry.id}`)">{{ entry.title }}</a></li>
      </ul>
    </nav>
    <template v-for="entry in entries" :key="entry.id">
      <section v-if="entry.kind === 'topic'" :id="entry.id" class="panel topic">
        <component :is="isFolded(entry.id) ? 'details' : 'div'" v-bind="isFolded(entry.id) ? { open: opened.has(entry.id), onToggle: (event: Event) => onToggle(entry.id, event) } : {}">
          <component :is="isFolded(entry.id) ? 'summary' : 'div'" :class="{ 'topic-summary': isFolded(entry.id) }">
            <h2>{{ topics[entry.topicIndex].title }}</h2>
          </component>
          <section v-for="section in topics[entry.topicIndex].sections" :key="section.heading">
            <h3>{{ section.heading }}</h3>
            <p v-for="(paragraph, index) in section.paragraphs ?? []" :key="index">{{ paragraph }}</p>
            <ol v-if="section.steps?.length">
              <li v-for="(step, index) in section.steps" :key="index">{{ step }}</li>
            </ol>
          </section>
        </component>
      </section>
      <section v-else id="glossary" class="panel topic">
        <h2>Glossary</h2>
        <dl class="glossary">
          <div v-for="item in glossary" :key="item.term">
            <dt>{{ item.term }}</dt>
            <dd>{{ item.definition }}</dd>
          </div>
        </dl>
      </section>
    </template>
  </main>
</template>

<style scoped>
.help-page { max-width: 52rem; margin: 0 auto; }
.home-link { margin: 0 0 1rem; }
.roles { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0 0 1rem; }
.topic-summary { cursor: pointer; }
.topic-summary h2 { display: inline; }
details > .topic-summary + section { margin-top: 1rem; }
.panel { margin-bottom: 1.2rem; }
.contents { margin: 0; padding-left: 1.2rem; display: grid; gap: .35rem; }
.topic { scroll-margin-top: 1rem; }
.topic section + section { margin-top: 1.4rem; }
.topic h3 { margin-bottom: .5rem; }
.topic ol { padding-left: 1.4rem; display: grid; gap: .45rem; margin: .6rem 0 0; }
.glossary { margin: 0; display: grid; gap: .9rem; }
.glossary dt { font-weight: 600; color: var(--gold); }
.glossary dd { margin: .15rem 0 0; color: var(--muted); }
</style>
