/**
 * Build the AI knowledge base.
 *
 * Compiles every piece of wiki content (rules prose, all tiles, gentry cards,
 * servants, families, component manifests, and the full FAQ) into a single plain
 * text document at public/ai-knowledge.txt.
 *
 * Vite copies public/ into dist/, so the file is served at
 *   <site>/ai-knowledge.txt
 * and the Cloudflare Worker fetches it as the AI's reference material. Because
 * it's regenerated on every build, the AI's knowledge always matches the wiki.
 *
 * Run via: npm run build:knowledge   (uses tsx; also runs as part of `npm run build`)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { BASE_FAMILIES, BASE_GENTRY, BASE_TILES, BASE_RULES } from '../src/data/base-game';
import { WESSEX_FAMILY, WESSEX_GENTRY, WESSEX_TILES } from '../src/data/wessex';
import { HOWARD_FAMILY, UD_GENTRY, UD_TILES, UD_RULES } from '../src/data/upstairs-downstairs';
import { CHARACTERS_GENTRY, CHARACTERS_RULES } from '../src/data/characters';
import { USEFUL_BOX_GENTRY, USEFUL_BOX_TILES, USEFUL_BOX_RULES, SORT_MANIFESTS } from '../src/data/useful-box';
import { ALL_SERVANTS } from '../src/data/servants';
import { FAQ_ENTRIES } from '../src/data/faq';
import type {
  Family, GentryCard, ImprovementTile, RuleSection, ServantDef, ServantType, SortManifest,
} from '../src/types';

const SERVANT_NAME: Record<ServantType, string> = Object.fromEntries(
  ALL_SERVANTS.map(s => [s.type, s.name]),
) as Record<ServantType, string>;

const EXP_LABEL: Record<string, string> = {
  base: 'Base Game',
  wessex: 'Wessex',
  'upstairs-downstairs': 'Upstairs, Downstairs',
  characters: 'Characters',
  'useful-box': 'Useful Box',
  promo: 'Promo',
};

const out: string[] = [];
const line = (s = '') => out.push(s);
const heading = (s: string) => { line(); line(`## ${s}`); line(); };

function renderRuleSection(sec: RuleSection, depth = 0): void {
  const prefix = depth === 0 ? '### ' : '#### ';
  line(`${prefix}${sec.title}`);
  line(sec.content.trim());
  line();
  sec.subsections?.forEach(sub => renderRuleSection(sub, depth + 1));
}

function renderRules(label: string, sections: RuleSection[]): void {
  heading(`RULES — ${label}`);
  sections.forEach(sec => renderRuleSection(sec));
}

function renderServant(s: ServantDef): void {
  const parts: string[] = [`- ${s.name} (${EXP_LABEL[s.expansion]}): ${s.description} Role: ${s.primaryRole}`];
  if (s.canSubstituteFor?.length) {
    parts.push(`Can substitute for: ${s.canSubstituteFor.map(t => SERVANT_NAME[t]).join(', ')}.`);
  }
  if (s.canBeSubstitutedBy?.length) {
    parts.push(`Can be substituted by: ${s.canBeSubstitutedBy.map(t => SERVANT_NAME[t]).join(', ')}.`);
  }
  if (s.specialAbility) parts.push(`Special: ${s.specialAbility}`);
  line(parts.join(' '));
}

function renderFamily(f: Family): void {
  const bits: string[] = [
    `- ${f.name} (${EXP_LABEL[f.expansion]}): starting reputation ${f.startingReputation}, starting money £${f.startingMoney}.`,
  ];
  if (f.extraServants?.length) bits.push(`Extra servants: ${f.extraServants.map(t => SERVANT_NAME[t]).join(', ')}.`);
  bits.push(`Special bonus: ${f.specialBonus}.`);
  bits.push(f.description);
  line(bits.join(' '));
}

function renderTile(t: ImprovementTile): void {
  const req = t.requires;
  const servants = req.servants.length ? req.servants.map(s => SERVANT_NAME[s]).join(' + ') : 'no servants';
  const guests = req.guestCount != null
    ? `${req.guestCount} guest${req.guestCount === 1 ? '' : 's'}${req.guestGender && req.guestGender !== 'any' ? ` (${req.guestGender})` : ''}`
    : 'no guests';
  const l1 = `L1: ${t.level1.vp} VP — ${t.level1.favors.join('; ')}`;
  const l2 = t.level2 ? ` | L2: ${t.level2.vp} VP — ${t.level2.favors.join('; ')}` : '';
  const cost = t.cost === 0 ? 'starting/free' : `£${t.cost}`;
  let s = `- ${t.name} [${t.category}, ${EXP_LABEL[t.expansion]}] — cost ${cost}, reputation req ${t.reputationRequired}. `
    + `Requires: ${servants}, ${guests}. ${l1}${l2}.`;
  if (t.notes) s += ` Note: ${t.notes}`;
  line(s);
}

function renderGentry(c: GentryCard): void {
  const favors = c.favors.map(f => f.description).join('; ');
  const rep = c.reputationRequired != null ? `, rep req ${c.reputationRequired}` : '';
  const gender = c.gender ? `, ${c.gender}` : '';
  line(`- ${c.name} [${c.type}, ${EXP_LABEL[c.expansion]}${gender}${rep}] — ${c.vp ?? 0} VP. Favours: ${favors}.`);
}

function renderManifest(m: SortManifest): void {
  line(`### ${m.label} — components`);
  if (m.gentry.length) {
    line(`Gentry cards: ${m.gentry.map(g => `${g.count} ${g.type}${g.notes ? ` (${g.notes})` : ''}`).join('; ')}.`);
  }
  if (m.tiles.length) {
    line(`Tiles: ${m.tiles.map(t => `${t.count} ${t.category} [${t.names.join(', ')}]`).join('; ')}.`);
  }
  if (m.servants.length) line(`Servants: ${m.servants.map(s => SERVANT_NAME[s]).join(', ')}.`);
  if (m.families.length) line(`Families: ${m.families.join(', ')}.`);
  if (m.specialComponents.length) line(`Other components: ${m.specialComponents.join('; ')}.`);
  line();
}

// ---- Assemble document -----------------------------------------------------

line('# OBSESSION — COMPLETE GAME REFERENCE');
line();
line('This is the full reference for the board game Obsession (Dan Hallagan, Kayenta Games) '
  + 'and its expansions (Wessex, Upstairs/Downstairs, Characters, Useful Box). It is the '
  + 'authoritative source for answering player questions. All tiles, cards, servants, families, '
  + 'rules, and FAQ entries from the wiki are included below.');

renderRules('Base Game', BASE_RULES);
renderRules('Upstairs, Downstairs', UD_RULES);
renderRules('Characters', CHARACTERS_RULES);
renderRules('Useful Box', USEFUL_BOX_RULES);

heading('SERVANTS (full list with substitution rules)');
ALL_SERVANTS.forEach(renderServant);

heading('PLAYABLE FAMILIES');
[...BASE_FAMILIES, WESSEX_FAMILY, HOWARD_FAMILY].forEach(renderFamily);

heading('IMPROVEMENT TILES (all expansions)');
[...BASE_TILES, ...WESSEX_TILES, ...UD_TILES, ...USEFUL_BOX_TILES].forEach(renderTile);

heading('GENTRY (GUEST) CARDS (all expansions)');
[...BASE_GENTRY, ...WESSEX_GENTRY, ...UD_GENTRY, ...CHARACTERS_GENTRY, ...USEFUL_BOX_GENTRY].forEach(renderGentry);

heading('COMPONENTS / WHAT IS IN EACH BOX');
SORT_MANIFESTS.forEach(renderManifest);

heading('FREQUENTLY ASKED QUESTIONS (official clarifications)');
FAQ_ENTRIES.forEach(e => {
  line(`Q: ${e.question}`);
  line(`A: ${e.answer}${e.source ? ` [Source: ${e.source}]` : ''}`);
  line();
});

const text = out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../public/ai-knowledge.txt');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, text, 'utf8');

console.log(`Wrote ${target} (${text.length} bytes, ~${Math.round(text.length / 4)} tokens)`);
