/**
 * The search over the creator's channel videos in 내 채널 영상 연결. Every
 * query word must appear in the title, a tag, the upload date as the card
 * shows it ("2024.05.13") or the description, or be the whole video ID.
 * Matching ignores case, spacing and Unicode composition, so '산후 조리원'
 * also finds '산후조리원'. Title hits rank above tag and date hits, and those
 * above description hits; equal scores keep the given (newest first) order.
 */

import type {YouTubeVideoItem} from '../types';
import {formatPublishedDate} from './format';

/** A [start, end) range of UTF-16 offsets. */
type Span = [number, number];

/** Text and the spans of it that the query matched. */
export interface Marked {
  text: string;
  spans: Span[];
}

export interface VideoHit {
  item: YouTubeVideoItem;
  title: Marked;
  /** The upload date as the card shows it. */
  date: Marked;
  /**
   * Where the query words missing from the title and date were found: the
   * matching tags, the description line, or the video ID.
   */
  extra: {label: string; marked: Marked} | null;
}

/** Text prepared for matching. */
interface Field {
  /** The NFC text, as shown. */
  text: string;
  /** The lowercase text without whitespace. */
  key: string;
  /** For each UTF-16 unit of key, the offset in text it came from. */
  from: number[];
}

interface Entry {
  item: YouTubeVideoItem;
  title: Field;
  date: Field;
  tags: Field[];
  description: Field;
  id: string;
}

// Description characters kept before the first match on its line, and the
// most kept in all (the line shows as one cut-off row anyway).
const LEAD_CHARS = 24;
const LINE_CHARS = 160;

function toField(raw: string): Field {
  const text = raw.normalize('NFC');
  let key = '';
  const from: number[] = [];
  for (const {0: run, index} of text.matchAll(/\S+/g)) {
    const lower = run.toLowerCase();
    // A run whose lowercase changes length (such as 'İ') stays as written,
    // so key and text units stay one to one.
    key += lower.length === run.length ? lower : run;
    for (let unit = 0; unit < run.length; unit++) {
      from.push(index + unit);
    }
  }
  return {text, key, from};
}

const entries = new WeakMap<YouTubeVideoItem, Entry>();

function entryOf(item: YouTubeVideoItem): Entry {
  let entry = entries.get(item);
  if (!entry) {
    entry = {
      item,
      title: toField(item.title),
      date: toField(formatPublishedDate(item.publishedAt)),
      tags: (item.tags ?? []).map(toField),
      description: toField(item.description),
      id: item.videoId.toLowerCase(),
    };
    entries.set(item, entry);
  }
  return entry;
}

/** Whether word starts a word of field: at its start or after a space or mark. */
function startsWord(field: Field, word: string): boolean {
  for (
    let at = field.key.indexOf(word);
    at >= 0;
    at = field.key.indexOf(word, at + 1)
  ) {
    const before = field.text[field.from[at] - 1];
    if (before === undefined || !/[\p{L}\p{N}]/u.test(before)) {
      return true;
    }
  }
  return false;
}

/** Points for the best place word matched, or 0 when it matched nowhere. */
function points(entry: Entry, word: string): number {
  if (entry.title.key.includes(word)) {
    // '12화' ranks '강의 12화' above '강의 112화'.
    return startsWord(entry.title, word) ? 12 : 10;
  }
  if (entry.id === word) {
    return 10;
  }
  if (entry.tags.some((tag) => tag.key === word)) {
    return 8;
  }
  if (
    entry.tags.some((tag) => tag.key.includes(word)) ||
    entry.date.key.includes(word)
  ) {
    return 6;
  }
  return entry.description.key.includes(word) ? 2 : 0;
}

/** Marks every occurrence of the words in field, merging overlaps. */
function mark(field: Field, words: readonly string[]): Marked {
  const found: Span[] = [];
  for (const word of words) {
    for (
      let at = field.key.indexOf(word);
      at >= 0;
      at = field.key.indexOf(word, at + 1)
    ) {
      found.push([field.from[at], field.from[at + word.length - 1] + 1]);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const spans: Span[] = [];
  for (const span of found) {
    const last = spans.at(-1);
    if (last && span[0] <= last[1]) {
      last[1] = Math.max(last[1], span[1]);
    } else {
      spans.push(span);
    }
  }
  return {text: field.text, spans};
}

/** The tags joined into one line, with the words marked. */
function tagLine(tags: readonly Field[], words: readonly string[]): Marked {
  let text = '';
  const spans: Span[] = [];
  for (const tag of tags) {
    if (text) {
      text += ', ';
    }
    const offset = text.length;
    for (const [start, end] of mark(tag, words).spans) {
      spans.push([offset + start, offset + end]);
    }
    text += tag.text;
  }
  return {text, spans};
}

/**
 * The description line holding the first of the rest words, starting a few
 * characters before it, with all words marked.
 */
function descriptionLine(
  field: Field,
  rest: readonly string[],
  words: readonly string[],
): Marked {
  const at = Math.min(
    ...rest.map((word) => field.key.indexOf(word)).filter((i) => i >= 0),
  );
  const hit = field.from[at];
  const lineStart = field.text.lastIndexOf('\n', hit) + 1;
  const newline = field.text.indexOf('\n', hit);
  let start = Math.max(lineStart, hit - LEAD_CHARS);
  // Keep an emoji's surrogate pair whole.
  if (/[\uDC00-\uDFFF]/.test(field.text[start])) {
    start -= 1;
  }
  const end = Math.min(
    newline < 0 ? field.text.length : newline,
    start + LINE_CHARS,
  );
  const lead = start > lineStart ? '…' : '';
  const line = mark(toField(field.text.slice(start, end)), words);
  return {
    text: lead + line.text,
    spans: line.spans.map(([s, e]): Span => [s + lead.length, e + lead.length]),
  };
}

function extra(entry: Entry, words: readonly string[]): VideoHit['extra'] {
  const rest = words.filter(
    (word) =>
      !entry.title.key.includes(word) && !entry.date.key.includes(word),
  );
  if (rest.length === 0) {
    return null;
  }
  const tags = entry.tags.filter((tag) =>
    rest.some((word) => tag.key.includes(word)),
  );
  if (tags.length > 0) {
    return {label: '태그', marked: tagLine(tags, words)};
  }
  if (rest.some((word) => entry.description.key.includes(word))) {
    return {
      label: '설명',
      marked: descriptionLine(entry.description, rest, words),
    };
  }
  const id = entry.item.videoId;
  return {label: '영상 ID', marked: {text: id, spans: [[0, id.length]]}};
}

/** The videos matching query, best first, with the matched text marked. */
export function searchVideos(
  videos: readonly YouTubeVideoItem[],
  query: string,
): VideoHit[] {
  const words = query
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => toField(word).key);
  if (words.length === 0) {
    return videos.map((item) => ({
      item,
      title: {text: item.title, spans: []},
      date: {text: formatPublishedDate(item.publishedAt), spans: []},
      extra: null,
    }));
  }
  const phrase = words.join('');
  const scored: {score: number; hit: VideoHit}[] = [];
  for (const item of videos) {
    const entry = entryOf(item);
    const each = words.map((word) => points(entry, word));
    if (each.includes(0)) {
      continue;
    }
    // The whole query in the title, spaces aside, ranks the video higher.
    const title = entry.title.key;
    const score =
      each.reduce((sum, value) => sum + value, 0) +
      (title.includes(phrase) ? 5 : 0) +
      (title.startsWith(phrase) ? 3 : 0) +
      (title === phrase ? 3 : 0);
    scored.push({
      score,
      hit: {
        item,
        title: mark(entry.title, words),
        date: mark(entry.date, words),
        extra: extra(entry, words),
      },
    });
  }
  // Array sort is stable, so equal scores stay newest first.
  return scored.sort((a, b) => b.score - a.score).map(({hit}) => hit);
}
