<script setup lang="ts">
import { computed } from 'vue';
import { glossary, topics } from './help/content';
import { identityPath } from './identity';

type Entry = { id: string; title: string; kind: 'topic' | 'glossary'; topicIndex: number };

const entries = computed<Entry[]>(() => {
  const list: Entry[] = topics.map((topic, topicIndex) => ({ id: topic.id, title: topic.title, kind: 'topic', topicIndex }));
  const glossaryEntry: Entry = { id: 'glossary', title: 'Glossary', kind: 'glossary', topicIndex: -1 };
  const before = list.findIndex(entry => entry.id === 'troubleshooting');
  if (before === -1) list.push(glossaryEntry);
  else list.splice(before, 0, glossaryEntry);
  return list;
});
</script>

<template>
  <main class="help-page">
    <h1>Help</h1>
    <p class="home-link"><a :href="identityPath('/')">Back to host home</a></p>
    <nav class="panel" aria-label="Help contents">
      <h2>Contents</h2>
      <ul class="contents">
        <li v-for="entry in entries" :key="entry.id"><a :href="identityPath(`/help#${entry.id}`)">{{ entry.title }}</a></li>
      </ul>
    </nav>
    <template v-for="entry in entries" :key="entry.id">
      <section v-if="entry.kind === 'topic'" :id="entry.id" class="panel topic">
        <h2>{{ topics[entry.topicIndex].title }}</h2>
        <section v-for="section in topics[entry.topicIndex].sections" :key="section.heading">
          <h3>{{ section.heading }}</h3>
          <p v-for="(paragraph, index) in section.paragraphs ?? []" :key="index">{{ paragraph }}</p>
          <ol v-if="section.steps?.length">
            <li v-for="(step, index) in section.steps" :key="index">{{ step }}</li>
          </ol>
        </section>
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
